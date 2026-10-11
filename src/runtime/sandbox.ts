// The hardened sandbox: parse a workflow file's `export const meta` literal, then run its body as a
// live async coroutine inside a node:vm context with code generation disabled (no eval/Function),
// dynamic import blocked, and Date.now/Math.random/new Date() shimmed to throw.

import { Script, createContext, type Context } from "node:vm"
import type { Meta, WorkflowGlobals } from "../dsl/types.js"

export class WorkflowSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowSyntaxError"
  }
}

export interface ParsedWorkflow {
  meta: Meta
  body: string
}

/** Extract the leading `export const meta = {...}` literal and return it + the remaining body. */
export function parseWorkflow(source: string): ParsedWorkflow {
  // `export const meta` must be the FIRST statement — only whitespace and comments may precede it.
  // Anchoring to the file start prevents silently discarding code that appears before a non-leading
  // meta declaration (the body slice below begins right after the meta literal).
  const lead = leadingNonCodeLength(source)
  const after = source.slice(lead)
  const m = /^export\s+const\s+meta\s*=\s*/.exec(after)
  if (!m) {
    throw new WorkflowSyntaxError("`export const meta = { name, description }` must be the first statement")
  }
  const braceStart = source.indexOf("{", lead + m[0].length - 1)
  if (braceStart < 0) throw new WorkflowSyntaxError("meta must be an object literal")
  const braceEnd = matchBrace(source, braceStart)
  const metaSrc = source.slice(braceStart, braceEnd + 1)

  let metaValue: unknown
  try {
    // Evaluate the literal in a throwaway, codegen-disabled context. Pure literals only.
    const ctx = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
    metaValue = new Script("(" + metaSrc + ")").runInContext(ctx, { timeout: 1000 })
  } catch (err) {
    throw new WorkflowSyntaxError(`meta is not a valid literal: ${(err as Error).message}`)
  }
  validateMeta(metaValue)

  // Consume an optional trailing semicolon right after the meta literal.
  let tailStart = braceEnd + 1
  const trailing = /^\s*;/.exec(source.slice(tailStart))
  if (trailing) tailStart += trailing[0].length

  // Preserve line numbers: replace everything stripped (leading comments + the meta declaration)
  // with the same count of blank lines so workflow stack traces point at the real source line.
  const stripped = source.slice(0, tailStart)
  const blanks = "\n".repeat(countNewlines(stripped))
  const body = blanks + source.slice(tailStart)
  return { meta: metaValue as Meta, body }
}

/** Length of the leading run of whitespace + line/block comments before the first real token. */
function leadingNonCodeLength(src: string): number {
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++
      continue
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i)
      i = nl < 0 ? src.length : nl
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2)
      i = end < 0 ? src.length : end + 2
      continue
    }
    break
  }
  return i
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++
  return n
}

function validateMeta(v: unknown): asserts v is Meta {
  if (typeof v !== "object" || v === null) throw new WorkflowSyntaxError("meta must be an object")
  const o = v as Record<string, unknown>
  if (typeof o.name !== "string" || o.name.length === 0) throw new WorkflowSyntaxError("meta.name must be a non-empty string")
  if (typeof o.description !== "string" || o.description.length === 0)
    throw new WorkflowSyntaxError("meta.description must be a non-empty string")
  // Entries stay lenient (display-only; the runtime skips unusable titles), but a non-array
  // container would crash the Runtime constructor's declared-phase loop AFTER the run dir and
  // journal exist — fail here, where every other meta mistake fails.
  if (o.phases !== undefined && !Array.isArray(o.phases)) throw new WorkflowSyntaxError("meta.phases must be an array")
  // Both-or-neither (see ProviderModelPair): a lone defaultModel would pair with a provider chosen
  // elsewhere — a model meant for a different provider. Failing here means `omegacode validate`
  // catches it without a run, before resolveDefaults re-checks at run time.
  if ((o.defaultProvider === undefined) !== (o.defaultModel === undefined)) {
    throw new WorkflowSyntaxError(
      "meta.defaultProvider and meta.defaultModel must be specified together (set both, or omit both)",
    )
  }
}

/** Match the brace at `open`, skipping strings and comments. Returns the index of the matching `}`. */
function matchBrace(src: string, open: string | number, _start?: number): number {
  const start = typeof open === "number" ? open : 0
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (c === "/" && next === "/") {
      i = src.indexOf("\n", i)
      if (i < 0) return src.length - 1
      continue
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2)
      i = end < 0 ? src.length : end + 1
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i, c)
      continue
    }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  throw new WorkflowSyntaxError("unbalanced braces in meta literal")
}

function skipString(src: string, i: number, quote: string): number {
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]
    if (c === "\\") {
      j++
      continue
    }
    if (c === quote) return j
  }
  return src.length
}

const DETERMINISM_PRELUDE = `
"use strict";
(function () {
  var RealDate = Date;
  var NOW_ERR = "Date.now()/new Date() are unavailable in workflows (breaks resume). Use now().";
  var RND_ERR = "Math.random() is unavailable in workflows (breaks resume). Use random().";
  Math.random = function random() { throw new Error(RND_ERR); };
  function ShimDate() {
    if (!(this instanceof ShimDate)) throw new Error(NOW_ERR);
    if (arguments.length === 0) throw new Error(NOW_ERR);
    return Reflect.construct(RealDate, Array.prototype.slice.call(arguments), ShimDate);
  }
  ShimDate.now = function () { throw new Error(NOW_ERR); };
  ShimDate.parse = RealDate.parse;
  ShimDate.UTC = RealDate.UTC;
  ShimDate.prototype = RealDate.prototype;
  // Close the (new Date(x)).constructor backdoor that would otherwise reach RealDate.now,
  // then freeze so the shims can't be reassigned. (Date/Math methods remain callable.)
  try { Object.defineProperty(RealDate.prototype, "constructor", { value: ShimDate, writable: false, configurable: false }); } catch (e) {}
  try { Object.freeze(RealDate); } catch (e) {}
  try { Object.freeze(Math); } catch (e) {}
  globalThis.Date = ShimDate;
  try { Object.freeze(globalThis.Date); } catch (e) {}
})();
`

export interface RunInSandboxOptions {
  body: string
  filename: string
  globals: WorkflowGlobals
  /** Bounds the synchronous portion (until the first await). Default 30s. */
  syncTimeoutMs?: number
  /** Aborts the whole run (including after the first await) — e.g. Ctrl-C. */
  signal?: AbortSignal
  /** Hard ceiling on total async execution. Default: unbounded (0). */
  execTimeoutMs?: number
}

export class WorkflowAbortedError extends Error {
  constructor(message = "workflow aborted") {
    super(message)
    this.name = "WorkflowAbortedError"
  }
}

export class WorkflowTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowTimeoutError"
  }
}

/** Run the workflow body and resolve with its return value. */
export async function runInSandbox(opts: RunInSandboxOptions): Promise<unknown> {
  // An already-aborted signal must not execute even the synchronous portion of the workflow.
  if (opts.signal?.aborted) throw new WorkflowAbortedError()
  const sandbox: Record<string, unknown> = {
    agent: opts.globals.agent,
    parallel: opts.globals.parallel,
    pipeline: opts.globals.pipeline,
    workflow: opts.globals.workflow,
    phase: opts.globals.phase,
    log: opts.globals.log,
    now: opts.globals.now,
    random: opts.globals.random,
    budget: opts.globals.budget,
    args: opts.globals.args,
    console,
    setTimeout,
    clearTimeout,
  }
  const context: Context = createContext(sandbox, {
    name: opts.filename,
    codeGeneration: { strings: false, wasm: false },
  })

  // Determinism shims (Date/Math) before user code.
  new Script(DETERMINISM_PRELUDE, { filename: "prelude.js" }).runInContext(context)

  // The prefix has NO newlines so the body keeps its original line numbers (parseWorkflow already
  // replaced the stripped meta region with blank lines). Workflow stack traces then point true.
  const wrapped = `(async () => { "use strict"; ${opts.body}\n})()`
  let script: Script
  try {
    script = new Script(wrapped, {
      filename: opts.filename,
      // Block dynamic import inside workflows.
      importModuleDynamically: (() => {
        throw new Error("import() is not available in workflows")
      }) as unknown as undefined,
    })
  } catch (err) {
    throw new WorkflowSyntaxError(
      `${(err as Error).message}. Workflow files are plain JavaScript — no TypeScript syntax, no imports.`,
    )
  }

  // The vm `timeout` bounds ONLY synchronous execution (until the first await). Async hangs
  // (`await new Promise(() => {})`) would otherwise run forever, so race the workflow promise
  // against the abort signal and an optional execution-time ceiling.
  const promise = script.runInContext(context, { timeout: opts.syncTimeoutMs ?? 30_000 }) as Promise<unknown>
  return await raceLifecycle(promise, opts.signal, opts.execTimeoutMs)
}

function raceLifecycle(work: Promise<unknown>, signal?: AbortSignal, execTimeoutMs?: number): Promise<unknown> {
  if (!signal && !execTimeoutMs) return work
  return new Promise<unknown>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
    }
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onAbort = (): void => finish(() => reject(new WorkflowAbortedError()))

    if (signal) {
      if (signal.aborted) {
        // The work promise keeps running (a vm can't be killed); consume its eventual
        // rejection so it never surfaces as an unhandledRejection crash.
        work.then(undefined, () => {})
        reject(new WorkflowAbortedError())
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
    if (execTimeoutMs && execTimeoutMs > 0) {
      timer = setTimeout(
        () => finish(() => reject(new WorkflowTimeoutError(`workflow exceeded ${execTimeoutMs}ms`))),
        execTimeoutMs,
      )
      timer.unref?.()
    }
    work.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    )
  })
}
