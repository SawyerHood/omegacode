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

  // Parse the literal strictly WITHOUT executing anything. The prior implementation vm-evaluated
  // `("+metaSrc+")"`, which ran arbitrary expressions smuggled into the "literal" — method calls
  // (`{name: "x".repeat(1e9)}`), getters, `__proto__` writes, computed keys, template interpolation
  // — with only a 1s timeout as a backstop. parseMetaLiteral accepts a closed pure-literal grammar
  // and rejects every expression form by name, so untrusted meta can never execute code.
  const metaValue = parseMetaLiteral(metaSrc)
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

// Every rejection message ends with this so an author who wrote real code where a literal belongs
// learns the rule, not just the symptom. Individual messages name the construct that was rejected.
const PURE_LITERAL_HINT = "meta must be a pure literal (no expressions, calls, or references)"
// Untrusted input has no execution timeout anymore, so a pathological `[[[[…]]]]` or `{a:{a:…}}`
// would otherwise stack-overflow the recursive descent. Real meta nests ~3 deep; 64 is ample.
const MAX_META_DEPTH = 64

/**
 * Strictly parse the extracted `{…}` meta literal into a plain value WITHOUT executing anything.
 * This is a validate-then-build recursive-descent parser over a closed grammar:
 *   object literals with identifier or plain-string keys; values limited to string literals
 *   (single/double/no-interpolation backtick), number literals (incl. negative), true/false/null,
 *   arrays of accepted values, and nested object literals. Comments and trailing commas are
 *   tolerated. Every expression form (computed keys, spreads, methods, getters/setters, template
 *   interpolation, function/arrow values, bare identifiers, method calls) is rejected by name.
 * Objects are built with a null prototype so a `__proto__` key (already rejected) can never
 * pollute Object.prototype the way the old throwaway-context evaluator could.
 */
function parseMetaLiteral(src: string): unknown {
  return new MetaLiteralParser(src).parse()
}

class MetaLiteralParser {
  private pos = 0
  constructor(private readonly src: string) {}

  parse(): unknown {
    // metaSrc always begins at the meta object's `{` (parseWorkflow located it), so this is an
    // object; parseValue keeps the dispatch uniform and still reports a good error otherwise.
    const value = this.parseValue(1)
    this.skipTrivia()
    if (this.pos < this.src.length) {
      throw this.fail(`unexpected trailing content after the meta literal; ${PURE_LITERAL_HINT}`)
    }
    return value
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_META_DEPTH) throw this.fail(`meta literal is nested too deeply (max ${MAX_META_DEPTH})`)
    this.skipTrivia()
    const c = this.src[this.pos]
    if (c === undefined) throw this.fail("unexpected end of meta literal")
    if (c === "{") return this.parseObject(depth)
    if (c === "[") return this.parseArray(depth)
    if (c === '"' || c === "'") return this.parseString(c)
    if (c === "`") return this.parseTemplate()
    if (c === "(") throw this.fail(`arrow functions and parenthesized expressions are not allowed; ${PURE_LITERAL_HINT}`)
    if (c === "-" || (c >= "0" && c <= "9") || c === ".") return this.parseNumber()
    if (this.isIdentStart(c)) return this.parseKeywordValue()
    throw this.fail(`unexpected character ${JSON.stringify(c)}; ${PURE_LITERAL_HINT}`)
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.pos++ // consume '{'
    const obj: Record<string, unknown> = Object.create(null)
    this.skipTrivia()
    if (this.src[this.pos] === "}") {
      this.pos++
      return obj
    }
    for (;;) {
      this.skipTrivia()
      const c = this.src[this.pos]
      if (c === undefined) throw this.fail("unterminated meta object")
      if (c === "[") throw this.fail(`computed keys are not allowed; ${PURE_LITERAL_HINT}`)
      if (c === ".") throw this.fail(`spread syntax is not allowed; ${PURE_LITERAL_HINT}`)

      const { name, ident } = this.parseKey()
      if (name === "__proto__" || name === "constructor" || name === "prototype") {
        throw this.fail(`reserved key "${name}" is not allowed; ${PURE_LITERAL_HINT}`)
      }

      this.skipTrivia()
      const sep = this.src[this.pos]
      if (sep !== ":") {
        if (sep === "(") throw this.fail(`method definitions are not allowed; ${PURE_LITERAL_HINT}`)
        if (ident && (name === "get" || name === "set") && this.startsMember(sep)) {
          throw this.fail(`getters/setters are not allowed; ${PURE_LITERAL_HINT}`)
        }
        if (sep === "," || sep === "}") throw this.fail(`shorthand properties are not allowed; ${PURE_LITERAL_HINT}`)
        if (sep === undefined) throw this.fail("unterminated meta object")
        throw this.fail(`expected ':' after property name "${name}"; ${PURE_LITERAL_HINT}`)
      }
      this.pos++ // consume ':'
      obj[name] = this.parseValue(depth + 1)

      this.skipTrivia()
      const after = this.src[this.pos]
      if (after === ",") {
        this.pos++
        this.skipTrivia()
        if (this.src[this.pos] === "}") {
          this.pos++ // trailing comma
          return obj
        }
        continue
      }
      if (after === "}") {
        this.pos++
        return obj
      }
      if (after === "." || after === "(") {
        throw this.fail(`method calls and property access are not allowed; ${PURE_LITERAL_HINT}`)
      }
      if (after === undefined) throw this.fail("unterminated meta object")
      throw this.fail(`expected ',' or '}' after a property value; ${PURE_LITERAL_HINT}`)
    }
  }

  private parseArray(depth: number): unknown[] {
    this.pos++ // consume '['
    const arr: unknown[] = []
    this.skipTrivia()
    if (this.src[this.pos] === "]") {
      this.pos++
      return arr
    }
    for (;;) {
      this.skipTrivia()
      const c = this.src[this.pos]
      if (c === undefined) throw this.fail("unterminated meta array")
      if (c === ".") throw this.fail(`spread syntax is not allowed; ${PURE_LITERAL_HINT}`)
      if (c === ",") throw this.fail(`elided array elements (holes) are not allowed; ${PURE_LITERAL_HINT}`)
      arr.push(this.parseValue(depth + 1))

      this.skipTrivia()
      const after = this.src[this.pos]
      if (after === ",") {
        this.pos++
        this.skipTrivia()
        if (this.src[this.pos] === "]") {
          this.pos++ // trailing comma
          return arr
        }
        continue
      }
      if (after === "]") {
        this.pos++
        return arr
      }
      if (after === "." || after === "(") {
        throw this.fail(`method calls and property access are not allowed; ${PURE_LITERAL_HINT}`)
      }
      if (after === undefined) throw this.fail("unterminated meta array")
      throw this.fail(`expected ',' or ']' in a meta array; ${PURE_LITERAL_HINT}`)
    }
  }

  /** A property key: a plain string literal or a bare identifier. Anything else is an expression. */
  private parseKey(): { name: string; ident: boolean } {
    const c = this.src[this.pos]
    if (c === '"' || c === "'") return { name: this.parseString(c), ident: false }
    if (c === "`") throw this.fail(`template-literal keys are not allowed; ${PURE_LITERAL_HINT}`)
    if (this.isIdentStart(c)) return { name: this.readIdentifier(), ident: true }
    throw this.fail(`expected a property name; ${PURE_LITERAL_HINT}`)
  }

  /** true/false/null are the only bare words a value may be; everything else is a reference. */
  private parseKeywordValue(): unknown {
    const word = this.readIdentifier()
    if (word === "true") return true
    if (word === "false") return false
    if (word === "null") return null
    if (word === "function" || word === "async") {
      throw this.fail(`function values are not allowed; ${PURE_LITERAL_HINT}`)
    }
    if (word === "undefined") throw this.fail(`\`undefined\` is not a literal; ${PURE_LITERAL_HINT}`)
    throw this.fail(`bare identifier \`${word}\` is not allowed as a value; ${PURE_LITERAL_HINT}`)
  }

  private parseString(quote: string): string {
    let out = ""
    let i = this.pos + 1
    for (; i < this.src.length; i++) {
      const c = this.src[i]
      if (c === "\\") {
        const e = this.decodeEscape(i)
        out += e.value
        i = e.next
        continue
      }
      if (c === quote) {
        this.pos = i + 1
        return out
      }
      if (c === "\n" || c === "\r") throw this.fail("unterminated string literal (raw newline)")
      out += c
    }
    throw this.fail("unterminated string literal in meta")
  }

  /** A backtick string is accepted ONLY without interpolation — `${…}` is an embedded expression. */
  private parseTemplate(): string {
    let out = ""
    let i = this.pos + 1
    for (; i < this.src.length; i++) {
      const c = this.src[i]
      if (c === "\\") {
        const e = this.decodeEscape(i)
        out += e.value
        i = e.next
        continue
      }
      if (c === "`") {
        this.pos = i + 1
        return out
      }
      if (c === "$" && this.src[i + 1] === "{") {
        this.pos = i
        throw this.fail(`template interpolation \`\${…}\` is not allowed; ${PURE_LITERAL_HINT}`)
      }
      out += c
    }
    throw this.fail("unterminated template literal in meta")
  }

  private parseNumber(): number {
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.src.slice(this.pos))
    if (!m) throw this.fail(`invalid number literal; ${PURE_LITERAL_HINT}`)
    this.pos += m[0].length
    const n = Number(m[0])
    if (!Number.isFinite(n)) throw this.fail(`invalid number literal; ${PURE_LITERAL_HINT}`)
    return n
  }

  /** Decode a backslash escape starting at `i` (src[i] === '\\'). Returns the decoded text and the
   *  index of the LAST character it consumed, so the caller's loop advances past the whole escape. */
  private decodeEscape(i: number): { value: string; next: number } {
    const c = this.src[i + 1]
    if (c === undefined) throw this.fail("dangling escape in meta string")
    switch (c) {
      case "n":
        return { value: "\n", next: i + 1 }
      case "t":
        return { value: "\t", next: i + 1 }
      case "r":
        return { value: "\r", next: i + 1 }
      case "b":
        return { value: "\b", next: i + 1 }
      case "f":
        return { value: "\f", next: i + 1 }
      case "v":
        return { value: "\v", next: i + 1 }
      case "\n":
        return { value: "", next: i + 1 } // line continuation
      case "\r":
        return { value: "", next: this.src[i + 2] === "\n" ? i + 2 : i + 1 } // CRLF or lone CR
      case "x": {
        const hex = this.src.slice(i + 2, i + 4)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw this.fail("invalid \\x escape in meta string")
        return { value: String.fromCharCode(parseInt(hex, 16)), next: i + 3 }
      }
      case "u": {
        if (this.src[i + 2] === "{") {
          const end = this.src.indexOf("}", i + 3)
          const hex = end < 0 ? "" : this.src.slice(i + 3, end)
          if (!/^[0-9a-fA-F]+$/.test(hex)) throw this.fail("invalid \\u{…} escape in meta string")
          const cp = parseInt(hex, 16)
          if (cp > 0x10ffff) throw this.fail("code point out of range in \\u{…} escape")
          return { value: String.fromCodePoint(cp), next: end }
        }
        const hex = this.src.slice(i + 2, i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.fail("invalid \\u escape in meta string")
        return { value: String.fromCharCode(parseInt(hex, 16)), next: i + 5 }
      }
    }
    // Octal escapes are forbidden in strict-mode string literals; reject to stay strict.
    const after = this.src[i + 2] ?? ""
    if ((c >= "1" && c <= "9") || (c === "0" && after >= "0" && after <= "9")) {
      throw this.fail("octal escapes are not allowed in meta strings")
    }
    if (c === "0") return { value: "\0", next: i + 1 }
    // Any other escaped char denotes itself (\\, \', \", \`, \/, …) — matches JS string semantics.
    return { value: c, next: i + 1 }
  }

  private skipTrivia(): void {
    const s = this.src
    for (;;) {
      const c = s[this.pos]
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
        this.pos++
        continue
      }
      if (c === "/" && s[this.pos + 1] === "/") {
        const nl = s.indexOf("\n", this.pos + 2)
        this.pos = nl < 0 ? s.length : nl
        continue
      }
      if (c === "/" && s[this.pos + 1] === "*") {
        const end = s.indexOf("*/", this.pos + 2)
        this.pos = end < 0 ? s.length : end + 2
        continue
      }
      break
    }
  }

  private isIdentStart(c: string | undefined): boolean {
    return c !== undefined && /[A-Za-z_$]/.test(c)
  }

  /** True if `c` could begin a property name — used to tell a getter/setter apart from a `get:` key. */
  private startsMember(c: string | undefined): boolean {
    return this.isIdentStart(c) || c === '"' || c === "'" || c === "`" || c === "["
  }

  private readIdentifier(): string {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.src.slice(this.pos))
    if (!m) throw this.fail(`expected an identifier; ${PURE_LITERAL_HINT}`)
    this.pos += m[0].length
    return m[0]
  }

  private fail(message: string): WorkflowSyntaxError {
    return new WorkflowSyntaxError(message)
  }
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
