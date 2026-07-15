// Git worktree isolation for parallel file-mutating agents. Matches Claude Code's behavior:
// create + lock a fresh worktree, and on teardown auto-remove if the agent changed nothing, or
// unlock + preserve the branch for review if it did. Creation is serialized by the caller.
//
// Two correctness rules drive this module:
//   - The base commit is recorded at CREATION time (in the worktree's local git config) and compared
//     against that exact base at teardown. Re-reading HEAD at teardown is wrong: if main advanced,
//     an agent's committed work would show 0-ahead and be force-deleted.
//   - Any failure to determine "did the agent change something" is treated as DIRTY. We preserve on
//     doubt and never force-delete on an undetected state.

import { execFile } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** Config key holding a worktree's creation base commit. Exported so the GC command (worktree-gc.ts)
 * reads the same key. NB: git writes this to the SHARED config (not per-worktree), so with multiple
 * live worktrees the last creation wins — the GC "ahead of base" column is best-effort for that reason. */
export const BASE_CONFIG_KEY = "omegacode.base"

export interface Worktree {
  path: string
  branch: string
  /** The commit this worktree was branched from, recorded at creation (for honest teardown). */
  base?: string
}

/** Run git in `cwd`, returning trimmed stdout; throws on non-zero exit. The single git-plumbing entry
 * point shared by this module and the worktree GC command (worktree-gc.ts). */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

export async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ["rev-parse", "--show-toplevel"])
  } catch {
    return null
  }
}

export async function createWorktree(args: {
  gitRoot: string
  runId: string
  index: number
  branch?: string
}): Promise<Worktree> {
  const name = `${args.runId}-${args.index}`
  const branch = args.branch ?? `aw/${name}`
  const path = join(args.gitRoot, ".omegacode", "worktrees", name)
  const base = await git(args.gitRoot, ["rev-parse", "HEAD"])

  // A crashed prior attempt can leave this exact path/branch behind (H9). `git worktree add` then
  // errors and the agent can never be resumed. Clear any stale registration + dir before adding.
  await pruneStaleWorktree(args.gitRoot, path)

  await git(args.gitRoot, ["worktree", "add", "--detach", path, base])
  await git(path, ["checkout", "-B", branch])
  // Record the creation base in the worktree's own config so teardown compares against the right
  // commit even though the caller may reconstruct the Worktree object without `base`.
  try {
    await git(path, ["config", BASE_CONFIG_KEY, base])
  } catch {
    // best-effort; teardown falls back to the threaded base and, failing that, preserves
  }
  try {
    await git(args.gitRoot, ["worktree", "lock", path, "--reason", `omegacode ${name}`])
  } catch {
    // lock is best-effort
  }
  return { path, branch, base }
}

/** Remove a leftover worktree registration/dir from a crashed attempt so a fresh add succeeds. */
async function pruneStaleWorktree(gitRoot: string, path: string): Promise<void> {
  // A prior attempt may have left this exact path registered, locked, and/or on disk. Clean all
  // three defensively (errors ignored) so the subsequent `worktree add` always succeeds. The prior
  // attempt's branch lives under aw/<name>; a resumed agent re-derives its work from the journal.
  // (Path-matching `worktree list` is unreliable across symlink canonicalization, so we don't gate
  // on it — we just unconditionally clear the target path.)
  await git(gitRoot, ["worktree", "unlock", path]).catch(() => {})
  await git(gitRoot, ["worktree", "remove", "--force", path]).catch(() => {})
  // A missing-but-locked registration needs prune after the unlock above.
  await git(gitRoot, ["worktree", "prune"]).catch(() => {})
  // If the directory itself still exists (remove failed / it was never registered), clear it.
  if (existsSync(path)) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // best-effort; the add below will surface a clear error if it truly can't proceed
    }
    await git(gitRoot, ["worktree", "prune"]).catch(() => {})
  }
}

export interface TeardownResult {
  changed: boolean
  preservedBranch?: string
  /** When preserved, where the agent's edits live (for surfacing to the user). */
  preservedPath?: string
}

/** Remove the worktree if clean; preserve (unlock) it if the agent made changes. Never throws. */
export async function teardownWorktree(args: { gitRoot: string; worktree: Worktree }): Promise<TeardownResult> {
  const { gitRoot, worktree } = args

  // Resolve the creation base: prefer a threaded value, else the worktree's recorded config.
  // If we can't establish the base, we cannot prove the work is clean → preserve.
  let base = worktree.base
  if (!base) {
    base = await git(worktree.path, ["config", "--get", BASE_CONFIG_KEY]).catch(() => "")
  }

  // changed === true means PRESERVE. Default to true; only a fully-successful clean check flips it.
  let changed = true
  if (base) {
    try {
      const porcelain = await git(worktree.path, ["status", "--porcelain"])
      const ahead = await git(worktree.path, ["rev-list", "--count", `${base}..HEAD`])
      changed = porcelain.length > 0 || ahead !== "0"
    } catch {
      // Any detection failure is treated as dirty → preserve, never force-delete.
      changed = true
    }
  }

  if (changed) {
    await git(gitRoot, ["worktree", "unlock", worktree.path]).catch(() => {})
    return { changed: true, preservedBranch: worktree.branch, preservedPath: worktree.path }
  }

  // Clean: safe to remove.
  try {
    await git(gitRoot, ["worktree", "unlock", worktree.path]).catch(() => {})
    await git(gitRoot, ["worktree", "remove", "--force", worktree.path])
    await git(gitRoot, ["branch", "-D", worktree.branch]).catch(() => {})
    return { changed: false }
  } catch {
    // Removal failed — leave it in place rather than risk losing anything.
    return { changed: true, preservedBranch: worktree.branch, preservedPath: worktree.path }
  }
}
