// Git worktree isolation for parallel file-mutating agents. Matches Claude Code's behavior:
// create + lock a fresh worktree, and on teardown auto-remove if the agent changed nothing, or
// unlock + preserve the branch for review if it did. Creation is serialized by the caller.

import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

export interface Worktree {
  path: string
  branch: string
}

async function git(cwd: string, args: string[]): Promise<string> {
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
  const path = join(args.gitRoot, ".agent-workflows", "worktrees", name)
  const base = await git(args.gitRoot, ["rev-parse", "HEAD"])
  await git(args.gitRoot, ["worktree", "add", "--detach", path, base])
  await git(path, ["checkout", "-B", branch])
  try {
    await git(args.gitRoot, ["worktree", "lock", path, "--reason", `agent-workflows ${name}`])
  } catch {
    // lock is best-effort
  }
  return { path, branch }
}

export interface TeardownResult {
  changed: boolean
  preservedBranch?: string
}

/** Remove the worktree if clean; preserve (unlock) it if the agent made changes. Never throws. */
export async function teardownWorktree(args: { gitRoot: string; worktree: Worktree }): Promise<TeardownResult> {
  const { gitRoot, worktree } = args
  let changed = false
  try {
    const porcelain = await git(worktree.path, ["status", "--porcelain"])
    const base = await git(gitRoot, ["rev-parse", "HEAD"])
    let ahead = "0"
    try {
      ahead = await git(worktree.path, ["rev-list", "--count", `${base}..HEAD`])
    } catch {
      ahead = "0"
    }
    changed = porcelain.length > 0 || ahead !== "0"
  } catch {
    changed = false
  }

  try {
    await git(gitRoot, ["worktree", "unlock", worktree.path]).catch(() => {})
    if (changed) {
      return { changed: true, preservedBranch: worktree.branch }
    }
    await git(gitRoot, ["worktree", "remove", "--force", worktree.path])
    await git(gitRoot, ["branch", "-D", worktree.branch]).catch(() => {})
    return { changed: false }
  } catch {
    return { changed }
  }
}
