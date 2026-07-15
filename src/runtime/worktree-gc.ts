// Garbage collection for leaked agent worktrees. A `worktree: true` agent that crashes (or whose
// work is preserved for review) leaves a registered worktree under <gitRoot>/.omegacode/worktrees/
// plus an aw/<runId>-<index> branch. teardownWorktree deliberately preserves dirty/ahead worktrees
// and never runs on a crash, so these accumulate forever (real usage: 1.3GB of leaked worktrees in
// one repo, stray aw/* branches across four). This module lists and prunes them.
//
// Safety rules mirror worktree.ts's "preserve on doubt" stance:
//   - A worktree whose owning run is LIVE (fresh .heartbeat under dataRoot/runs/<runId>) is never
//     pruned, even with --force — a concurrent in-flight run must not have its worktree/branch
//     reclaimed. Lock status can't tell live from crashed (createWorktree locks both), so we use the
//     heartbeat deadman signal instead.
//   - A worktree with a DIRTY working tree is never removed without --force (uncommitted work).
//   - A DETACHED worktree with unmerged commits has no branch ref to hold its work, so removing it
//     would orphan the commits — it is skipped unconditionally.
//   - A branch is only deleted when it is provably free of unique work — i.e. fully merged into
//     HEAD. We use merged-into-HEAD (not the recorded base) as the gate on purpose: BASE_CONFIG_KEY
//     is stored in the SHARED config so it aliases across live worktrees and can't be trusted for a
//     deletion decision, whereas `rev-list HEAD..<branch>` is always correct. Deletes use
//     `git branch -d` (lowercase) so git's own merged check is a second line of defense.

import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, join, sep } from "node:path"
import { runDir } from "./journal.js"
import { BASE_CONFIG_KEY, git } from "./worktree.js"

/** A run is "live" if its heartbeat file was touched within this window. run.ts beats every 5s; this
 * matches isStaleRun's (cli.ts) 20s deadman threshold. */
const ACTIVE_HEARTBEAT_MS = 20_000

export interface WorktreeEntry {
  path: string
  /** The checked-out branch (aw/<runId>-<index>), or "(detached)". */
  branch: string
  /** Working tree has uncommitted changes (git status --porcelain non-empty). */
  dirty: boolean
  /** Commits ahead of the recorded creation base, or null when it can't be determined (best-effort;
   * BASE_CONFIG_KEY aliases across live worktrees — see the module header). */
  ahead: number | null
  /** The recorded creation base commit, if any. */
  base: string | null
  /** Whether the branch (or, when detached, the worktree's HEAD commit) is fully merged into the
   * repo's HEAD — the branch-deletion safety gate, and for a detached worktree the removal gate. */
  merged: boolean
  /** The owning run is currently live (fresh heartbeat). Live worktrees are never pruned, even with
   * --force — a concurrent in-flight run must not have its worktree/branch reclaimed out from under it. */
  active: boolean
  /** Disk footprint of the worktree directory, in bytes. */
  sizeBytes: number
}

export interface OrphanBranch {
  /** An aw/* branch with no worktree checked out on it. */
  branch: string
  tip: string
  /** Fully merged into HEAD — provably no unique work, safe to delete. */
  merged: boolean
}

export interface WorktreeListing {
  repo: string
  worktrees: WorktreeEntry[]
  orphanBranches: OrphanBranch[]
}

export interface WorktreePruneResult {
  repo: string
  worktrees: Array<{
    path: string
    branch: string
    /** Worktree directory removed. */
    removed: boolean
    /** Branch ref deleted (only when merged); false means the ref was preserved. */
    branchDeleted: boolean
    /** Present when the worktree was left in place; explains why. */
    skipped?: string
    /** Present when the dir was removed but the branch was intentionally kept. */
    branchPreserved?: string
    freedBytes: number
  }>
  orphanBranches: Array<{ branch: string; deleted: boolean; skipped?: string }>
  freedBytes: number
}

interface RegisteredWorktree {
  path: string
  branch: string | null
}

/** Directory size in bytes, recursive. Best-effort: unreadable entries are skipped. */
function dirSize(dir: string): number {
  let total = 0
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return total
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    try {
      total += e.isDirectory() ? dirSize(p) : statSync(p).size
    } catch {
      // vanished / permission — skip
    }
  }
  return total
}

/** Parse `git worktree list --porcelain` into path + short branch (null when detached). */
function parseWorktreeList(out: string): RegisteredWorktree[] {
  const records: RegisteredWorktree[] = []
  let cur: Partial<RegisteredWorktree> | null = null
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur?.path) records.push({ path: cur.path, branch: cur.branch ?? null })
      cur = { path: line.slice("worktree ".length), branch: null }
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch refs/heads/".length)
    } else if (line === "detached" && cur) {
      cur.branch = null
    }
  }
  if (cur?.path) records.push({ path: cur.path, branch: cur.branch ?? null })
  return records
}

/** Is a merged? (a fully reachable from b's HEAD) via `rev-list --count b..a === 0`. */
async function isMerged(gitRoot: string, ref: string): Promise<boolean> {
  try {
    return (await git(gitRoot, ["rev-list", "--count", `HEAD..${ref}`])) === "0"
  } catch {
    return false // undetectable → treat as unmerged → preserve
  }
}

/** The runId owning a managed worktree, parsed from its dir name `<runId>-<index>` (index is always a
 * numeric array position, so strip only the final `-<digits>`). Null if the name doesn't match. */
function runIdForPath(path: string): string | null {
  const m = basename(path).match(/^(.+)-\d+$/)
  return m ? m[1]! : null
}

/** Is the run that owns this worktree still live? True when its heartbeat (dataRoot/runs/<runId>/
 * .heartbeat, refreshed by run.ts) is fresh. Crash orphans have a missing/stale heartbeat and stay
 * prunable; a live run — including one that just created its worktree and hasn't written yet — does
 * not. Note the heartbeat lives under dataRoot (~/.omegacode), independent of the git repo. */
function isRunActive(runId: string | null): boolean {
  if (!runId) return false
  try {
    return Date.now() - statSync(join(runDir(runId), ".heartbeat")).mtimeMs < ACTIVE_HEARTBEAT_MS
  } catch {
    return false // no heartbeat → not live → prunable
  }
}

/** List every managed worktree under <gitRoot>/.omegacode/worktrees/ plus orphaned aw/* branches. */
export async function listWorktrees(gitRoot: string): Promise<WorktreeListing> {
  const worktreesDir = join(gitRoot, ".omegacode", "worktrees")
  const registered = parseWorktreeList(await git(gitRoot, ["worktree", "list", "--porcelain"]).catch(() => ""))
  const managed = registered.filter((w) => w.path.startsWith(worktreesDir + sep))

  const worktrees: WorktreeEntry[] = []
  for (const w of managed) {
    const branch = w.branch ?? "(detached)"
    const dirty = (await git(w.path, ["status", "--porcelain"]).catch(() => "!")) !== ""
    const base = (await git(w.path, ["config", "--get", BASE_CONFIG_KEY]).catch(() => "")) || null
    let ahead: number | null = null
    if (base) {
      const n = await git(w.path, ["rev-list", "--count", `${base}..HEAD`]).catch(() => "")
      ahead = /^\d+$/.test(n) ? Number(n) : null
    }
    // Merged gate: for a branch worktree, is the branch in HEAD. For a DETACHED worktree there's no
    // branch to preserve its commits, so removing it would orphan them — gate on the worktree's own
    // HEAD commit and preserve on doubt (unreadable HEAD → unmerged), never hard-code merged=true.
    let merged: boolean
    if (w.branch) {
      merged = await isMerged(gitRoot, w.branch)
    } else {
      const head = await git(w.path, ["rev-parse", "HEAD"]).catch(() => "")
      merged = head ? await isMerged(gitRoot, head) : false
    }
    const active = isRunActive(runIdForPath(w.path))
    worktrees.push({ path: w.path, branch, dirty, ahead, base, merged, active, sizeBytes: dirSize(w.path) })
  }

  // Orphaned aw/* branches: an aw/* ref with no worktree checked out on it.
  const checkedOut = new Set(registered.map((w) => w.branch).filter((b): b is string => b !== null))
  const awOut = await git(gitRoot, ["branch", "--list", "aw/*", "--format", "%(refname:short)"]).catch(() => "")
  const awBranches = awOut ? awOut.split("\n").filter(Boolean) : []
  const orphanBranches: OrphanBranch[] = []
  for (const branch of awBranches) {
    if (checkedOut.has(branch)) continue
    const tip = await git(gitRoot, ["rev-parse", branch]).catch(() => "")
    orphanBranches.push({ branch, tip, merged: await isMerged(gitRoot, branch) })
  }

  return { repo: gitRoot, worktrees, orphanBranches }
}

/**
 * Prune leaked worktrees and orphan branches. Clean worktrees are removed (dir + merged branch);
 * dirty ones are skipped unless `force`. A removed worktree's branch is deleted only when merged —
 * otherwise the ref is preserved (force never deletes an unmerged branch). Merged orphan branches
 * are deleted; unmerged ones are always preserved.
 */
export async function pruneWorktrees(gitRoot: string, opts: { force?: boolean } = {}): Promise<WorktreePruneResult> {
  const force = opts.force === true
  const { worktrees, orphanBranches } = await listWorktrees(gitRoot)

  const wtResults: WorktreePruneResult["worktrees"] = []
  for (const w of worktrees) {
    if (w.active) {
      // A live run owns this worktree (fresh heartbeat). Never reclaim it — not even with --force,
      // which only overrides dirtiness, never the safety of an in-flight run.
      wtResults.push({ path: w.path, branch: w.branch, removed: false, branchDeleted: false, skipped: "active run (fresh heartbeat) — not pruned", freedBytes: 0 })
      continue
    }
    if (w.branch === "(detached)" && !w.merged) {
      // Detached HEAD carrying unmerged commits: there is no branch ref to preserve them, so removing
      // the directory would orphan the work. Skip unconditionally (force can't make this safe).
      wtResults.push({ path: w.path, branch: w.branch, removed: false, branchDeleted: false, skipped: "detached HEAD with unmerged commits — no branch to preserve; not pruned", freedBytes: 0 })
      continue
    }
    if (w.dirty && !force) {
      wtResults.push({ path: w.path, branch: w.branch, removed: false, branchDeleted: false, skipped: "dirty (uncommitted changes) — rerun with --force", freedBytes: 0 })
      continue
    }
    // Remove the worktree directory. Unlock first (best-effort) so a locked, preserved worktree can go.
    await git(gitRoot, ["worktree", "unlock", w.path]).catch(() => {})
    try {
      await git(gitRoot, ["worktree", "remove", "--force", w.path])
    } catch (err) {
      wtResults.push({ path: w.path, branch: w.branch, removed: false, branchDeleted: false, skipped: `could not remove: ${err instanceof Error ? err.message : String(err)}`, freedBytes: 0 })
      continue
    }
    // Delete the branch only when merged; otherwise preserve the ref (never lose committed work).
    let branchDeleted = false
    let branchPreserved: string | undefined
    if (w.branch !== "(detached)") {
      if (w.merged) {
        // `-d` (not `-D`): git re-checks merged-into-HEAD, a second gate behind our own check.
        branchDeleted = await git(gitRoot, ["branch", "-d", w.branch]).then(() => true).catch(() => false)
        if (!branchDeleted) branchPreserved = `branch ${w.branch} preserved (git refused deletion)`
      } else {
        // The dir is reclaimed but the ref carries committed work → keep it. It's fully recoverable
        // by re-attaching a worktree to the branch, so this is never data loss (see module header).
        branchPreserved = `branch ${w.branch} preserved (unmerged commits — recover with 'git worktree add <path> ${w.branch}')`
      }
    }
    wtResults.push({ path: w.path, branch: w.branch, removed: true, branchDeleted, branchPreserved, freedBytes: w.sizeBytes })
  }

  const branchResults: WorktreePruneResult["orphanBranches"] = []
  for (const b of orphanBranches) {
    if (!b.merged) {
      // Force never deletes an unmerged branch — the ref carries work found nowhere else.
      branchResults.push({ branch: b.branch, deleted: false, skipped: "unmerged commits — ref preserved" })
      continue
    }
    const deleted = await git(gitRoot, ["branch", "-d", b.branch]).then(() => true).catch(() => false)
    branchResults.push({ branch: b.branch, deleted, skipped: deleted ? undefined : "git refused deletion — ref preserved" })
  }

  const freedBytes = wtResults.reduce((s, r) => s + r.freedBytes, 0)
  return { repo: gitRoot, worktrees: wtResults, orphanBranches: branchResults, freedBytes }
}
