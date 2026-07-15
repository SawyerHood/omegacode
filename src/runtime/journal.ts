// journal.jsonl — the resume log. Each completed agent() result is appended, keyed by a chained
// hash so re-running replays the unchanged prefix. See keys.ts for the hashing scheme.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { AgentStatus, AgentUsage, ProviderId } from "../dsl/types.js"

export interface JournalMeta {
  type: "meta"
  runId: string
  workflowFile: string
  fileHash: string
  args: unknown
  seed: number
  createdAt: number
  /**
   * Key-hashing scheme version (see keys.ts). A resume against a different version is rejected.
   * Absent in baseline (v1) journals — the field predates them — so absent IS v1 on resume.
   */
  keyVersion?: string
}

export interface JournalStarted {
  type: "started"
  key: string
  index: number
  label: string
  provider: ProviderId
}

export interface JournalResult {
  type: "result"
  key: string
  index: number
  status: AgentStatus
  /** The agent's return value: final text, or the validated structured object. */
  result: unknown
  usage: AgentUsage
  provider: ProviderId
  worktreeBranch?: string
  durationMs: number
}

export type JournalEntry = JournalMeta | JournalStarted | JournalResult

export interface LoadedJournal {
  meta?: JournalMeta
  /** key -> result (last one wins on duplicates). Only `completed` results are replayable. */
  results: Map<string, JournalResult>
  /**
   * key -> display index, from started AND result entries (so an interrupted agent that never
   * journaled a result still keeps its index). The runtime reuses these on resume so the agent's
   * events and its agents/<index>.jsonl transcript stay associated across attempts (L12).
   */
  indexByKey: Map<string, number>
}

/** Root data dir: ~/.omegacode (override with OMEGACODE_HOME). */
export function dataRoot(): string {
  return process.env.OMEGACODE_HOME ?? join(homedir(), ".omegacode")
}

export function runDir(runId: string): string {
  return join(dataRoot(), "runs", runId)
}

export function journalPath(runId: string): string {
  return join(runDir(runId), "journal.jsonl")
}

export function ensureRunDir(runId: string): string {
  const dir = runDir(runId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Run ids that have a journal on disk (newest first), for "did you mean" resume errors. */
export function listRunIds(): string[] {
  const dir = join(dataRoot(), "runs")
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "journal.jsonl")))
    .map((e) => e.name)
    .sort()
    .reverse()
}

/** Thrown when a run id has no journal at all (so resume cannot recover anything). */
export class JournalNotFoundError extends Error {
  constructor(
    public readonly runId: string,
    public readonly knownRunIds: string[] = [],
  ) {
    const nearby = knownRunIds.slice(0, 5)
    super(
      `no journal found for run "${runId}"` +
        (nearby.length > 0 ? ` — known runs: ${nearby.join(", ")}` : ""),
    )
    this.name = "JournalNotFoundError"
  }
}

/** Thrown when a resume's workflow/args/key-version no longer match the journaled run. */
export class ResumePreconditionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResumePreconditionError"
  }
}

export class Journal {
  private readonly path: string
  constructor(private readonly runId: string) {
    this.path = journalPath(runId)
    mkdirSync(dirname(this.path), { recursive: true })
  }

  append(entry: JournalEntry): void {
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8")
  }

  /** True if a journal file exists for this run id (vs. a typo'd / absent run). */
  static exists(runId: string): boolean {
    return existsSync(journalPath(runId))
  }

  static load(runId: string): LoadedJournal {
    const path = journalPath(runId)
    const out: LoadedJournal = { results: new Map(), indexByKey: new Map() }
    if (!existsSync(path)) return out
    const text = readFileSync(path, "utf8")
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry: JournalEntry
      try {
        entry = JSON.parse(trimmed) as JournalEntry
      } catch {
        continue // skip unparseable / torn line
      }
      if (entry.type === "meta") out.meta = entry
      else if (entry.type === "result") out.results.set(entry.key, entry)
      if ((entry.type === "started" || entry.type === "result") && typeof entry.index === "number") {
        out.indexByKey.set(entry.key, entry.index)
      }
    }
    return out
  }
}

/**
 * Verify that a journal can be safely resumed against the current workflow. The cache key scheme
 * already invalidates individual agents whose semantics changed, but the fileHash/args/keyVersion
 * are run-wide invariants: replaying journaled results from a different source file, different args,
 * or an older key version would silently mis-attribute or mis-bill. Fail fast instead.
 */
export function checkResumePreconditions(
  meta: JournalMeta | undefined,
  current: { fileHash: string; args: unknown; keyVersion: string },
): void {
  if (!meta) return // a journal with no meta (legacy/partial) — nothing to check
  // Baseline (v1) journals never wrote keyVersion, so an ABSENT field means v1 — not "skip the
  // check". Skipping would resume with 100% key misses: a full silent re-bill (the C1 failure mode).
  const journaledVersion = meta.keyVersion ?? "v1"
  if (journaledVersion !== current.keyVersion) {
    throw new ResumePreconditionError(
      `cannot resume: this run was journaled with key version ${journaledVersion}, but the current scheme is ${current.keyVersion}. Start a fresh run.`,
    )
  }
  if (meta.fileHash !== current.fileHash) {
    throw new ResumePreconditionError(
      "cannot resume: the workflow file has changed since this run was started. Start a fresh run, or revert the file.",
    )
  }
  if (canonicalArgs(meta.args) !== canonicalArgs(current.args)) {
    throw new ResumePreconditionError(
      "cannot resume: the run args differ from the journaled run. Start a fresh run, or pass the original args.",
    )
  }
}

function canonicalArgs(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export function writeResult(runId: string, value: unknown): void {
  const dir = ensureRunDir(runId)
  writeFileSync(join(dir, "result.json"), JSON.stringify(value, null, 2), "utf8")
}

/** A non-completed run's machine-readable outcome (the shape writeFailureResult persists). */
export interface FailureResult {
  status: "failed" | "interrupted"
  error?: string
}

/**
 * Machine-readable outcome for a run that did NOT complete. Written to the same result.json the
 * success path uses (which holds the bare return value), but with an explicit {status, error}
 * envelope so tooling can distinguish a failed/interrupted run from a completed one without
 * scraping events.jsonl — previously a failed run left no result.json at all, so callers were
 * smuggling verdicts through thrown Error strings. The viewer folds status from events.jsonl and
 * never reads this file, so the envelope shape cannot affect run rendering.
 */
export function writeFailureResult(runId: string, result: FailureResult): void {
  const dir = ensureRunDir(runId)
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2), "utf8")
}
