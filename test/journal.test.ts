import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkResumePreconditions,
  ensureRunDir,
  Journal,
  JournalNotFoundError,
  journalPath,
  listRunIds,
  ResumePreconditionError,
  runDir,
  writeResult,
  type JournalMeta,
} from "../src/runtime/journal.ts"
import { emptyUsage } from "../src/dsl/types.ts"

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "omega-journal-"))
  const prev = process.env.OMEGACODE_HOME
  process.env.OMEGACODE_HOME = home
  try {
    return fn(home)
  } finally {
    if (prev === undefined) delete process.env.OMEGACODE_HOME
    else process.env.OMEGACODE_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

const usage = emptyUsage()

test("append then load round-trips meta and results", () => {
  withHome(() => {
    const j = new Journal("run1")
    j.append({ type: "meta", runId: "run1", workflowFile: "/w.js", fileHash: "abc", args: null, seed: 1, createdAt: 100, keyVersion: "v2" })
    j.append({ type: "started", key: "k1", index: 1, label: "a", provider: "codex" })
    j.append({ type: "result", key: "k1", index: 1, status: "completed", result: "hello", usage, provider: "codex", durationMs: 5 })
    const loaded = Journal.load("run1")
    assert.equal(loaded.meta?.fileHash, "abc")
    assert.equal(loaded.meta?.keyVersion, "v2")
    assert.equal(loaded.results.size, 1)
    assert.equal(loaded.results.get("k1")?.result, "hello")
  })
})

test("load returns empty (no throw) for an absent journal", () => {
  withHome(() => {
    const loaded = Journal.load("nope")
    assert.equal(loaded.meta, undefined)
    assert.equal(loaded.results.size, 0)
    assert.equal(loaded.indexByKey.size, 0)
  })
})

test("L12: load builds indexByKey from started AND result entries", () => {
  withHome(() => {
    const j = new Journal("idx")
    j.append({ type: "started", key: "k1", index: 1, label: "a", provider: "codex" })
    j.append({ type: "result", key: "k1", index: 1, status: "completed", result: "x", usage, provider: "codex", durationMs: 1 })
    // k2 was started but never completed (interrupted) — its index must still be recoverable so a
    // resume re-run keeps writing agents/2.jsonl instead of claiming someone else's index.
    j.append({ type: "started", key: "k2", index: 2, label: "b", provider: "codex" })
    const loaded = Journal.load("idx")
    assert.equal(loaded.indexByKey.get("k1"), 1)
    assert.equal(loaded.indexByKey.get("k2"), 2)
  })
})

test("Journal.exists distinguishes a real run from a typo (M21)", () => {
  withHome(() => {
    assert.equal(Journal.exists("ghost"), false)
    new Journal("real").append({ type: "started", key: "k", index: 1, label: "l", provider: "codex" })
    assert.equal(Journal.exists("real"), true)
  })
})

test("load skips torn/unparseable trailing lines", () => {
  withHome(() => {
    new Journal("torn").append({ type: "result", key: "k1", index: 1, status: "completed", result: 1, usage, provider: "codex", durationMs: 1 })
    // simulate a torn final write
    writeFileSync(journalPath("torn"), "{not json", { flag: "a" })
    const loaded = Journal.load("torn")
    assert.equal(loaded.results.size, 1)
  })
})

test("last-write-wins on duplicate keys", () => {
  withHome(() => {
    const j = new Journal("dup")
    j.append({ type: "result", key: "k", index: 1, status: "completed", result: "first", usage, provider: "codex", durationMs: 1 })
    j.append({ type: "result", key: "k", index: 1, status: "completed", result: "second", usage, provider: "codex", durationMs: 1 })
    assert.equal(Journal.load("dup").results.get("k")?.result, "second")
  })
})

test("a failed result is loaded and retains status FAILED (replay honoring is the runtime's job)", () => {
  withHome(() => {
    new Journal("f").append({ type: "result", key: "k", index: 1, status: "failed", result: null, usage, provider: "codex", durationMs: 1 })
    const r = Journal.load("f").results.get("k")
    assert.equal(r?.status, "failed")
  })
})

const baseMeta: JournalMeta = {
  type: "meta",
  runId: "r",
  workflowFile: "/w.js",
  fileHash: "HASH",
  args: { topic: "x" },
  seed: 1,
  createdAt: 1,
  keyVersion: "v2",
}

test("checkResumePreconditions passes (no warnings) on a matching journal", () => {
  assert.deepEqual(checkResumePreconditions(baseMeta, { fileHash: "HASH", args: { topic: "x" }, keyVersion: "v2" }), [])
})

test("checkResumePreconditions WARNS (not rejects) on a changed file hash", () => {
  // A file edit is no longer fatal: keys are positional+content, so unchanged agents still replay and
  // only edited agents re-run. Users can fix a bug mid-workflow instead of re-paying the whole run.
  const warnings = checkResumePreconditions(baseMeta, { fileHash: "OTHER", args: { topic: "x" }, keyVersion: "v2" })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /workflow file changed/)
})

test("checkResumePreconditions STILL rejects when args changed even though the file also changed", () => {
  // Args stay a run-wide invariant: a resume that edits both the file AND the args must error, never
  // warn-and-proceed (the fileHash warning must not mask an args mismatch).
  assert.throws(
    () => checkResumePreconditions(baseMeta, { fileHash: "OTHER", args: { topic: "y" }, keyVersion: "v2" }),
    ResumePreconditionError,
  )
})

test("checkResumePreconditions rejects changed args", () => {
  assert.throws(
    () => checkResumePreconditions(baseMeta, { fileHash: "HASH", args: { topic: "y" }, keyVersion: "v2" }),
    ResumePreconditionError,
  )
})

test("checkResumePreconditions rejects a stale key version", () => {
  assert.throws(
    () => checkResumePreconditions({ ...baseMeta, keyVersion: "v1" }, { fileHash: "HASH", args: { topic: "x" }, keyVersion: "v2" }),
    ResumePreconditionError,
  )
})

test("a v1 journal (NO keyVersion field) is rejected on resume — absent means v1, not skip-the-check", () => {
  // Baseline journals never wrote keyVersion. Treating absence as "nothing to compare" would let a
  // v1 journal resume under the current scheme with 100% key misses — a full silent re-bill (C1).
  const { keyVersion: _dropped, ...v1Meta } = baseMeta
  assert.throws(
    () => checkResumePreconditions(v1Meta as JournalMeta, { fileHash: "HASH", args: { topic: "x" }, keyVersion: "v3" }),
    (e: unknown) => e instanceof ResumePreconditionError && /key version v1/.test((e as Error).message),
  )
})

test("checkResumePreconditions is a no-op when meta is absent", () => {
  checkResumePreconditions(undefined, { fileHash: "anything", args: 42, keyVersion: "v2" })
})

test("checkResumePreconditions treats undefined/null args as equal", () => {
  checkResumePreconditions({ ...baseMeta, args: null }, { fileHash: "HASH", args: undefined, keyVersion: "v2" })
})

test("runDir / journalPath / ensureRunDir use OMEGACODE_HOME", () => {
  withHome((home) => {
    assert.ok(runDir("x").startsWith(home))
    assert.ok(journalPath("x").endsWith(join("x", "journal.jsonl")))
    const dir = ensureRunDir("x")
    assert.ok(dir.startsWith(home))
  })
})

test("writeResult writes result.json", () => {
  withHome((home) => {
    writeResult("rr", { ok: true })
    const p = join(home, "runs", "rr", "result.json")
    const txt = readFileSync(p, "utf8")
    assert.deepEqual(JSON.parse(txt), { ok: true })
  })
})

test("JournalNotFoundError carries the run id", () => {
  const e = new JournalNotFoundError("typo")
  assert.equal(e.runId, "typo")
  assert.match(e.message, /typo/)
})

test("JournalNotFoundError lists nearby run ids when provided (M21)", () => {
  const e = new JournalNotFoundError("typo", ["wf_aaa", "wf_bbb"])
  assert.match(e.message, /wf_aaa/)
  assert.match(e.message, /wf_bbb/)
  // capped at 5 so a huge runs dir doesn't flood the error
  const many = new JournalNotFoundError("typo", ["a", "b", "c", "d", "e", "f", "g"])
  assert.ok(!many.message.includes("f,") && !many.message.includes(", g"))
})

test("listRunIds returns only run dirs that actually have a journal", () => {
  withHome(() => {
    assert.deepEqual(listRunIds(), [])
    new Journal("wf_one").append({ type: "started", key: "k", index: 1, label: "l", provider: "codex" })
    new Journal("wf_two").append({ type: "started", key: "k", index: 1, label: "l", provider: "codex" })
    ensureRunDir("wf_empty") // a run dir without a journal must not be listed
    const ids = listRunIds()
    assert.deepEqual([...ids].sort(), ["wf_one", "wf_two"])
  })
})

test("latestRunIdForFile is removed (dead API, L13)", async () => {
  const mod = await import("../src/runtime/journal.ts")
  assert.equal((mod as Record<string, unknown>).latestRunIdForFile, undefined)
})
