import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorktree, type Worktree } from "../src/runtime/worktree.ts"
import { listWorktrees, pruneWorktrees } from "../src/runtime/worktree-gc.ts"

const exec = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

let root: string
let repo: string
let prevOmegaHome: string | undefined

/** Fabricate a fresh heartbeat for a runId under dataRoot (= OMEGACODE_HOME), marking its run "live". */
function markRunActive(runId: string): void {
  const rd = join(process.env.OMEGACODE_HOME!, "runs", runId)
  mkdirSync(rd, { recursive: true })
  writeFileSync(join(rd, ".heartbeat"), String(Date.now())) // fresh mtime → within the deadman window
}

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(root, "repo-"))
  await git(dir, ["init", "-q"])
  await git(dir, ["config", "user.email", "t@t.t"])
  await git(dir, ["config", "user.name", "t"])
  await git(dir, ["config", "commit.gpgsign", "false"])
  writeFileSync(join(dir, "a.txt"), "hello\n")
  await git(dir, ["add", "."])
  await git(dir, ["commit", "-q", "-m", "init"])
  await git(dir, ["branch", "-M", "main"]).catch(() => {})
  return dir
}

/** Commit a file inside a worktree so its aw/* branch is one commit ahead of its base (unmerged). */
async function commitIn(wt: Worktree, name: string): Promise<void> {
  writeFileSync(join(wt.path, name), "work\n")
  await git(wt.path, ["add", "."])
  await git(wt.path, ["commit", "-q", "-m", name])
}

/** Detach a worktree's registration/dir but leave its branch behind — how a crash orphans an aw/* branch. */
async function orphanBranch(wt: Worktree): Promise<void> {
  await git(repo, ["worktree", "unlock", wt.path]).catch(() => {})
  await git(repo, ["worktree", "remove", "--force", wt.path])
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omega-wtgc-"))
  // Isolate the run-state dir (heartbeats) into the temp tree so the active-run guard reads only
  // fabricated state and never the developer's real ~/.omegacode.
  prevOmegaHome = process.env.OMEGACODE_HOME
  process.env.OMEGACODE_HOME = join(root, "omega-home")
  repo = await makeRepo()
})

afterEach(() => {
  if (prevOmegaHome === undefined) delete process.env.OMEGACODE_HOME
  else process.env.OMEGACODE_HOME = prevOmegaHome
  rmSync(root, { recursive: true, force: true })
})

test("list: a fresh clean worktree is reported clean, 0-ahead, merged, with a recorded base", async () => {
  const wt = await createWorktree({ gitRoot: repo, runId: "run1", index: 0 })
  const { repo: reportedRoot, worktrees, orphanBranches } = await listWorktrees(repo)
  assert.equal(reportedRoot, repo)
  assert.equal(worktrees.length, 1)
  const e = worktrees[0]!
  assert.equal(e.path, wt.path)
  assert.equal(e.branch, "aw/run1-0")
  assert.equal(e.dirty, false)
  assert.equal(e.ahead, 0) // no commits beyond the recorded base
  assert.equal(e.merged, true) // branch == base == HEAD, so nothing unique
  assert.equal(e.base, await git(repo, ["rev-parse", "HEAD"]))
  assert.ok(e.sizeBytes > 0)
  assert.deepEqual(orphanBranches, [])
})

test("list: a worktree with uncommitted changes is reported dirty", async () => {
  const wt = await createWorktree({ gitRoot: repo, runId: "run2", index: 0 })
  writeFileSync(join(wt.path, "scratch.txt"), "unsaved\n")
  const { worktrees } = await listWorktrees(repo)
  assert.equal(worktrees.length, 1)
  assert.equal(worktrees[0]!.dirty, true)
})

test("list: a worktree with a committed-ahead branch is clean-but-unmerged with ahead=1", async () => {
  // Single worktree only: createWorktree writes omegacode.base to the SHARED config, so a second
  // live worktree would overwrite this one's base and skew the ahead count (aliasing is documented).
  const wt = await createWorktree({ gitRoot: repo, runId: "run3", index: 0 })
  await commitIn(wt, "feature.txt")
  const { worktrees } = await listWorktrees(repo)
  const e = worktrees[0]!
  assert.equal(e.dirty, false) // working tree is clean...
  assert.equal(e.ahead, 1) // ...but one commit ahead of its base
  assert.equal(e.merged, false) // and that commit is not in HEAD
})

test("list: an aw/* branch with no worktree is reported as an orphan with its merged status", async () => {
  // merged orphan: a bare branch pointing at HEAD (nothing unique)
  await git(repo, ["branch", "aw/merged", "HEAD"])
  // unmerged orphan: commit in a worktree, then detach it, leaving the branch behind
  const wt = await createWorktree({ gitRoot: repo, runId: "run4", index: 0 })
  await commitIn(wt, "orphan-work.txt")
  await orphanBranch(wt)

  const { worktrees, orphanBranches } = await listWorktrees(repo)
  assert.equal(worktrees.length, 0) // the detached worktree is gone
  const byName = new Map(orphanBranches.map((o) => [o.branch, o]))
  assert.equal(byName.get("aw/merged")!.merged, true)
  assert.equal(byName.get("aw/run4-0")!.merged, false)
  assert.ok(byName.get("aw/run4-0")!.tip.length > 0)
})

test("prune: a clean worktree is removed and its branch deleted", async () => {
  const wt = await createWorktree({ gitRoot: repo, runId: "run5", index: 0 })
  const res = await pruneWorktrees(repo)
  assert.equal(res.worktrees.length, 1)
  const r = res.worktrees[0]!
  assert.equal(r.removed, true)
  assert.equal(r.branchDeleted, true)
  assert.ok(r.freedBytes > 0)
  assert.equal(res.freedBytes, r.freedBytes)
  assert.ok(!existsSync(wt.path))
  assert.equal(await git(repo, ["branch", "--list", "aw/run5-0"]), "")
})

test("prune: a clean-but-ahead worktree has its dir reclaimed while the unmerged branch is preserved", async () => {
  // The design's subtlest case: clean/dirty is defined purely by `git status --porcelain`, so a
  // worktree with a clean working tree but committed-ahead work is CLEAN — its directory is reclaimed
  // even WITHOUT --force, yet the never-delete-unmerged rule preserves the branch carrying the commit.
  const wt = await createWorktree({ gitRoot: repo, runId: "run6a", index: 0 })
  await commitIn(wt, "committed.txt") // committed work; working tree clean; branch unmerged
  const res = await pruneWorktrees(repo) // NO --force
  const r = res.worktrees[0]!
  assert.equal(r.removed, true) // porcelain-clean → dir reclaimed even without --force
  assert.equal(r.branchDeleted, false) // ...but unmerged committed work is never deleted
  assert.match(r.branchPreserved ?? "", /unmerged/)
  assert.ok(!existsSync(wt.path))
  assert.notEqual(await git(repo, ["branch", "--list", "aw/run6a-0"]), "") // the ref survives
})

test("prune: a dirty worktree is skipped (and preserved) without --force", async () => {
  const wt = await createWorktree({ gitRoot: repo, runId: "run6", index: 0 })
  writeFileSync(join(wt.path, "scratch.txt"), "unsaved\n")
  const res = await pruneWorktrees(repo)
  const r = res.worktrees[0]!
  assert.equal(r.removed, false)
  assert.match(r.skipped ?? "", /dirty/)
  assert.equal(res.freedBytes, 0)
  assert.ok(existsSync(wt.path)) // still on disk
  assert.notEqual(await git(repo, ["branch", "--list", "aw/run6-0"]), "") // branch preserved
})

test("prune --force: a dirty worktree is removed but its unmerged branch is preserved", async () => {
  const wt = await createWorktree({ gitRoot: repo, runId: "run7", index: 0 })
  await commitIn(wt, "committed.txt") // an unmerged commit on the branch...
  writeFileSync(join(wt.path, "scratch.txt"), "unsaved\n") // ...plus an uncommitted change (dirty)
  const res = await pruneWorktrees(repo, { force: true })
  const r = res.worktrees[0]!
  assert.equal(r.removed, true) // --force removed the dirty directory
  assert.equal(r.branchDeleted, false) // but NEVER deleted the unmerged branch
  assert.match(r.branchPreserved ?? "", /unmerged/)
  assert.ok(!existsSync(wt.path))
  assert.notEqual(await git(repo, ["branch", "--list", "aw/run7-0"]), "") // ref survives
})

test("prune: a merged orphan branch is deleted; an unmerged orphan is preserved", async () => {
  await git(repo, ["branch", "aw/merged", "HEAD"]) // merged orphan (no unique work)
  const wt = await createWorktree({ gitRoot: repo, runId: "run8", index: 0 })
  await commitIn(wt, "orphan-work.txt")
  await orphanBranch(wt) // aw/run8-0 now orphaned with an unmerged commit

  const res = await pruneWorktrees(repo)
  const byName = new Map(res.orphanBranches.map((o) => [o.branch, o]))
  assert.equal(byName.get("aw/merged")!.deleted, true)
  assert.equal(byName.get("aw/run8-0")!.deleted, false)
  assert.match(byName.get("aw/run8-0")!.skipped ?? "", /unmerged/)
  assert.equal(await git(repo, ["branch", "--list", "aw/merged"]), "")
  assert.notEqual(await git(repo, ["branch", "--list", "aw/run8-0"]), "")
})

test("prune --force: an unmerged orphan branch is STILL preserved (force never deletes work)", async () => {
  const wt = await createWorktree({ gitRoot: repo, runId: "run9", index: 0 })
  await commitIn(wt, "orphan-work.txt")
  await orphanBranch(wt)
  const res = await pruneWorktrees(repo, { force: true })
  const r = res.orphanBranches.find((o) => o.branch === "aw/run9-0")!
  assert.equal(r.deleted, false)
  assert.notEqual(await git(repo, ["branch", "--list", "aw/run9-0"]), "")
})

test("active run: a live worktree (fresh heartbeat) is listed active and never pruned, even with --force", async () => {
  // A clean, merged, just-created worktree is maximally exposed — but its run is live, so prune must
  // leave both the directory and the branch untouched. The heartbeat is the discriminator (a crash
  // orphan, also locked+clean+merged, has no fresh heartbeat and IS prunable — see other tests).
  const wt = await createWorktree({ gitRoot: repo, runId: "live1", index: 0 })
  markRunActive("live1")

  const { worktrees } = await listWorktrees(repo)
  assert.equal(worktrees[0]!.active, true)

  const res = await pruneWorktrees(repo, { force: true }) // even --force must not touch a live run
  const r = res.worktrees[0]!
  assert.equal(r.removed, false)
  assert.match(r.skipped ?? "", /active/)
  assert.equal(res.freedBytes, 0)
  assert.ok(existsSync(wt.path)) // directory intact
  assert.notEqual(await git(repo, ["branch", "--list", "aw/live1-0"]), "") // branch intact
})

test("detached HEAD with unmerged commits is listed unmerged and skipped by prune (no ref to preserve it)", async () => {
  const wt = await createWorktree({ gitRoot: repo, runId: "det1", index: 0 })
  await commitIn(wt, "unique.txt") // a commit reachable only from this worktree...
  await git(wt.path, ["checkout", "--detach"]) // ...now detach so the branch can be removed
  await git(repo, ["branch", "-D", "aw/det1-0"]) // commit now lives ONLY at the detached HEAD

  const { worktrees } = await listWorktrees(repo)
  const e = worktrees[0]!
  assert.equal(e.branch, "(detached)")
  assert.equal(e.merged, false) // not hard-coded true — the unique commit is not in HEAD

  const res = await pruneWorktrees(repo, { force: true }) // force cannot make ref-less removal safe
  const r = res.worktrees[0]!
  assert.equal(r.removed, false)
  assert.match(r.skipped ?? "", /detached/)
  assert.ok(existsSync(wt.path)) // commit preserved on disk
})

test("list/prune are inert on a repo with no leaked worktrees", async () => {
  const { worktrees, orphanBranches } = await listWorktrees(repo)
  assert.deepEqual(worktrees, [])
  assert.deepEqual(orphanBranches, [])
  const res = await pruneWorktrees(repo)
  assert.deepEqual(res.worktrees, [])
  assert.deepEqual(res.orphanBranches, [])
  assert.equal(res.freedBytes, 0)
})
