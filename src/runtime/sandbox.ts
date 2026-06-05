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
  const m = /(^|\n)\s*export\s+const\s+meta\s*=\s*/.exec(source)
  if (!m || m.index === undefined) {
    throw new WorkflowSyntaxError("`export const meta = { name, description }` must be the first statement")
  }
  const braceStart = source.indexOf("{", m.index + m[0].length - 1)
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

  let body = source.slice(braceEnd + 1)
  // drop an optional trailing semicolon/newline right after the meta literal
  body = body.replace(/^\s*;?\s*\n?/, "\n")
  return { meta: metaValue as Meta, body }
}

function validateMeta(v: unknown): asserts v is Meta {
  if (typeof v !== "object" || v === null) throw new WorkflowSyntaxError("meta must be an object")
  const o = v as Record<string, unknown>
  if (typeof o.name !== "string" || o.name.length === 0) throw new WorkflowSyntaxError("meta.name must be a non-empty string")
  if (typeof o.description !== "string" || o.description.length === 0)
    throw new WorkflowSyntaxError("meta.description must be a non-empty string")
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
}

/** Run the workflow body and resolve with its return value. */
export async function runInSandbox(opts: RunInSandboxOptions): Promise<unknown> {
  const sandbox: Record<string, unknown> = {
    agent: opts.globals.agent,
    parallel: opts.globals.parallel,
    pipeline: opts.globals.pipeline,
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

  const wrapped = `(async () => {\n"use strict";\n${opts.body}\n})()`
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

  const promise = script.runInContext(context, { timeout: opts.syncTimeoutMs ?? 30_000 }) as Promise<unknown>
  return await promise
}
