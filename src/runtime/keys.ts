// Chained call-key hashing for resume + a static determinism lint.
//
// Keys are per-branch deterministic. Each branch (the top-level body, each parallel() thunk, each
// pipeline() item, each pipeline() stage) carries its own lineage so the key of an agent() call
// depends only on WHERE it sits in the call tree — not on the wall-clock order in which sibling
// branches happen to finish. This is what makes resume cache-hit under concurrency.
//
//   branchKey   = hash(parentKey || kind || index)         -- derive a child lineage node
//   agentKey_i  = hash(branchKey || "agent" || i || prompt || canonical(keyedOpts))
//
// Each parallel()/pipeline() CALL is itself a lineage node, keyed by a per-branch fan-out call
// counter (the runtime's KeyContext). Without that counter, two sequential identical fan-outs in
// one branch would derive identical child lineages and collide on the same journal slots —
// wrong-result replay on resume (the loop-until-dry pattern re-issues identical fan-outs per round).
//
// Chaining off branchKey (not a global "last completed" key) yields longest-unchanged-prefix replay
// that is invariant to concurrency. opts.key still overrides the content hash for stability.

import { createHash } from "node:crypto"
import type { AgentOpts } from "../dsl/types.js"

// v3: per-branch key lineage PLUS a per-branch fan-out call counter (v2 lacked the counter, so two
// sequential identical parallel()/pipeline() calls in one branch derived identical child keys —
// demonstrated wrong-result replay). v2 introduced per-branch lineage over v1's global
// completion-ordered prevKey and folded the full resolved spec (sandbox/worktree/approval/etc.)
// into the key. Any v1/v2 journal is intentionally rejected on resume (see checkResumePreconditions).
export const KEY_VERSION = "v3"

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

/**
 * The semantics-bearing fields that participate in the cache key. Built from the RESOLVED values so
 * that defaults/CLI overrides (--provider, --model, --sandbox, …) correctly invalidate the cache —
 * keying off raw opts alone would silently replay stale results when a default changed (H8).
 * `worktree` is carried from opts (it is not part of the resolved AgentSpec until setup time).
 */
export interface KeyedFields {
  provider: string | null
  model: string | null
  effort: string | null
  sandbox: string | null
  approval: string | null
  cwd: string | null
  instructions: string | null
  schema: unknown
  maxTurns: number | null
  worktree: unknown
}

export function keyedSpec(spec: KeyedSpecInput, worktree: unknown): KeyedFields {
  return {
    provider: spec.provider ?? null,
    model: spec.model ?? null,
    effort: spec.effort ?? null,
    sandbox: spec.sandbox ?? null,
    approval: spec.approval ?? null,
    cwd: spec.cwd ?? null,
    instructions: spec.instructions ?? null,
    schema: spec.schema ?? null,
    maxTurns: spec.maxTurns ?? null,
    worktree: worktree ?? null,
  }
}

export interface KeyedSpecInput {
  provider?: string
  model?: string
  effort?: string
  sandbox?: string
  approval?: string
  cwd?: string
  instructions?: string
  schema?: unknown
  maxTurns?: number
}

/** The subset of OPTS that participates in the cache key (used where a resolved spec isn't handy). */
export function keyedOpts(opts: AgentOpts | undefined): KeyedFields {
  const o = opts ?? {}
  return keyedSpec(o, o.worktree)
}

/** The root branch key for a run. All lineage descends from here. */
export const ROOT_KEY = createHash("sha256").update(KEY_VERSION).update("\0root\0").digest("hex")

/**
 * Derive a child branch key from a parent. `kind` distinguishes the branching primitive
 * (parallel/pipeline/stage) and `index` is the deterministic position within the parent branch.
 */
export function branchKey(parentKey: string, kind: string, index: number): string {
  return createHash("sha256")
    .update(KEY_VERSION)
    .update(parentKey)
    .update("\0branch\0")
    .update(kind)
    .update("\0")
    .update(String(index))
    .digest("hex")
}

/**
 * Compute the chained key for an agent() call within a branch. `index` is the deterministic
 * position of this call inside its branch. `fields` are the resolved semantic fields (see
 * keyedSpec / keyedOpts). Explicit keys (opts.key) are handled by the caller via explicitKey().
 */
export function chainKey(branchKeyValue: string, index: number, prompt: string, fields: KeyedFields): string {
  return createHash("sha256")
    .update(KEY_VERSION)
    .update(branchKeyValue)
    .update("\0agent\0")
    .update(String(index))
    .update("\0")
    .update(prompt)
    .update("\0")
    .update(canonical(fields))
    .digest("hex")
}

/** The journal key for an explicit opts.key. Exposed for duplicate-detection. */
export function explicitKey(key: string): string {
  return createHash("sha256").update(KEY_VERSION).update("\0explicit\0").update(key).digest("hex")
}

// --- Determinism lint (static) ----------------------------------------------------------------
// Replay correctness needs the workflow body to be deterministic between agent calls. We forbid
// raw Date.now()/Math.random()/new Date() at submit time (the sandbox also makes them throw). We
// strip strings and comments first so a prompt or comment that merely *mentions* Date.now() does
// not block the workflow — only real code references do.

const FORBIDDEN = [
  { re: /\bDate\s*\.\s*now\b/, hint: "Date.now()", use: "now()" },
  { re: /\bMath\s*\.\s*random\b/, hint: "Math.random()", use: "random()" },
  { re: /\bnew\s+Date\s*\(\s*\)/, hint: "new Date()", use: "now()" },
]

// The sandbox has no module system and no Node globals; a `require()` or `process.*` reference deep
// in a branch throws ReferenceError only when reached — possibly after paid agents already ran.
// Flag them at submit time, same as the determinism rules.
const NOT_IN_SANDBOX = [
  { re: /\brequire\s*\(/, hint: "require()", use: "workflows have no module system — inline the logic" },
  // Only known Node `process` members — a broad `process.\w+` also flagged user objects like
  // `obj.process.status`, rejecting workflows that never touch the Node global.
  { re: /\bprocess\s*\.\s*(env|argv|exit|cwd|platform|stdout|stderr|version)\b/, hint: "process.*", use: "pass values in via --args" },
  { re: /\bmodule\s*\.\s*exports\b/, hint: "module.exports", use: "a top-level return" },
]

export interface LintFinding {
  token: string
  use: string
}

export function determinismLint(source: string): LintFinding[] {
  return lint(source, FORBIDDEN)
}

export function sandboxLint(source: string): LintFinding[] {
  return lint(source, NOT_IN_SANDBOX)
}

function lint(source: string, rules: typeof FORBIDDEN): LintFinding[] {
  const code = stripStringsAndComments(source)
  const findings: LintFinding[] = []
  for (const f of rules) {
    if (f.re.test(code)) findings.push({ token: f.hint, use: f.use })
  }
  return findings
}

/**
 * Replace the contents of string/template literals and comments with spaces (preserving length and
 * newlines) so the lint regexes only see executable code. Best-effort lexer: it does not need to be
 * a full JS parser, only good enough that mentioning `Date.now()` inside a string or comment is not
 * a false positive.
 *
 * Template-literal interpolations are the one exception: code inside `${...}` is REAL code and must
 * be preserved (linted), including nested template literals inside it. A context stack tracks whether
 * we are blanking template text or preserving interpolation code, and a per-interpolation brace depth
 * finds the matching `}` (object literals / blocks inside the interpolation stay balanced).
 *
 * Known limitation: regex literals are NOT stripped, so `/process.env/` in a regex could false-positive.
 */
function stripStringsAndComments(src: string): string {
  let out = ""
  let i = 0
  const n = src.length
  // Context stack (bottom is implicit top-level code):
  //   { kind: "template" }      -> inside a `...` literal; text is blanked, `${` opens an interp
  //   { kind: "interp", depth } -> inside `${ ... }`; code is PRESERVED, the matching `}` closes it
  const stack: Array<{ kind: "template" } | { kind: "interp"; depth: number }> = []
  while (i < n) {
    const frame = stack[stack.length - 1]
    // Inside a template literal: blank the text, but `${` switches back to (preserved) code.
    if (frame && frame.kind === "template") {
      const d = src[i]
      if (d === "\\") {
        out += "  "
        i += 2
        continue
      }
      if (d === "`") {
        out += " "
        i++
        stack.pop()
        continue
      }
      if (d === "$" && src[i + 1] === "{") {
        out += "  "
        i += 2
        stack.push({ kind: "interp", depth: 0 })
        continue
      }
      out += d === "\n" ? "\n" : " "
      i++
      continue
    }
    // Code mode (top-level, or inside an interpolation): strip comments/strings, preserve the rest.
    const c = src[i]
    const next = src[i + 1]
    if (c === "/" && next === "/") {
      out += "  "
      i += 2
      while (i < n && src[i] !== "\n") {
        out += " "
        i++
      }
      continue
    }
    if (c === "/" && next === "*") {
      out += "  "
      i += 2
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " "
        i++
      }
      if (i < n) {
        out += "  "
        i += 2
      }
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      out += " "
      i++
      while (i < n) {
        const d = src[i]
        if (d === "\\") {
          out += "  "
          i += 2
          continue
        }
        if (d === quote) {
          out += " "
          i++
          break
        }
        out += d === "\n" ? "\n" : " "
        i++
      }
      continue
    }
    if (c === "`") {
      out += " "
      i++
      stack.push({ kind: "template" })
      continue
    }
    // Brace tracking only matters inside an interpolation: the matching `}` ends it.
    if (frame && frame.kind === "interp") {
      if (c === "{") {
        frame.depth++
        out += c
        i++
        continue
      }
      if (c === "}") {
        if (frame.depth === 0) {
          out += " "
          i++
          stack.pop()
          continue
        }
        frame.depth--
        out += c
        i++
        continue
      }
    }
    out += c
    i++
  }
  return out
}
