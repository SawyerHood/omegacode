// Chained call-key hashing for resume + a static determinism lint.
//
// key_i = sha256(key_{i-1} || prompt || canonical(keyedOpts))
// keyedOpts = the semantics-bearing fields (provider, model, effort, schema, sandbox, cwd,
// instructions) — NOT label/phase/key. Chaining yields longest-unchanged-prefix replay.

import { createHash } from "node:crypto"
import type { AgentOpts } from "../dsl/types.js"

const KEY_VERSION = "v1"

/** Stable JSON: object keys sorted recursively so equal values hash equally. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(sortDeep)
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) {
    if (k === "__proto__") continue
    out[k] = sortDeep(obj[k])
  }
  return out
}

/** The subset of opts that participates in the cache key. */
export function keyedOpts(opts: AgentOpts | undefined): Record<string, unknown> {
  const o = opts ?? {}
  return {
    provider: o.provider ?? null,
    model: o.model ?? null,
    effort: o.effort ?? null,
    sandbox: o.sandbox ?? null,
    cwd: o.cwd ?? null,
    instructions: o.instructions ?? null,
    schema: o.schema ?? null,
    maxTurns: o.maxTurns ?? null,
  }
}

/** Compute the next chained key. If opts.key is set, it overrides the content hash for stability. */
export function chainKey(prevKey: string, prompt: string, opts: AgentOpts | undefined): string {
  if (opts?.key) {
    return createHash("sha256").update(KEY_VERSION).update("\0explicit\0").update(opts.key).digest("hex")
  }
  return createHash("sha256")
    .update(KEY_VERSION)
    .update(prevKey)
    .update("\0")
    .update(prompt)
    .update("\0")
    .update(canonical(keyedOpts(opts)))
    .digest("hex")
}

export const ROOT_KEY = "root"

// --- Determinism lint (static) ----------------------------------------------------------------
// Replay correctness needs the workflow body to be deterministic between agent calls. We forbid
// raw Date.now()/Math.random()/new Date() at submit time (the sandbox also makes them throw).

const FORBIDDEN = [
  { re: /\bDate\s*\.\s*now\b/, hint: "Date.now()", use: "now()" },
  { re: /\bMath\s*\.\s*random\b/, hint: "Math.random()", use: "random()" },
  { re: /\bnew\s+Date\s*\(\s*\)/, hint: "new Date()", use: "now()" },
]

export interface LintFinding {
  token: string
  use: string
}

export function determinismLint(source: string): LintFinding[] {
  const findings: LintFinding[] = []
  for (const f of FORBIDDEN) {
    if (f.re.test(source)) findings.push({ token: f.hint, use: f.use })
  }
  return findings
}
