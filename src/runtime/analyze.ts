// Static workflow analysis: fail-fast errors + advisory warnings without running anything.
// Complements determinismLint (which guards resume correctness) with authoring checks:
// unknown workflow() refs, unbounded loops, and phase titles outside the declared plan.
// Heuristics stay narrow on purpose: the blessed patterns in the skill (dedup barriers,
// loop-until-dry, conditional phases) must NOT trip them.

import { parseWorkflow } from "./sandbox.js"
import { resolveWorkflowName } from "./registry.js"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

export interface WorkflowIssue {
  code: "missing-workflow-ref" | "unbounded-loop" | "undeclared-phase"
  message: string
  line?: number
}

export interface WorkflowAnalysis {
  errors: WorkflowIssue[]
  warnings: WorkflowIssue[]
}

/** Analyze a workflow source. Never throws on analyzable code (parse errors propagate). */
export function analyzeWorkflow(source: string, opts?: { cwd?: string }): WorkflowAnalysis {
  const errors: WorkflowIssue[] = []
  const warnings: WorkflowIssue[] = []
  const cwd = opts?.cwd ?? process.cwd()
  const parsed = parseWorkflow(source)
  const body = parsed.body

  // 1. workflow("ref") with a literal ref must resolve (file or registry name). Dynamic refs
  //    (variables, concatenation) are invisible here and checked at run time instead.
  const callRe = /\bworkflow\s*\(\s*(["'`])/g
  let cm: RegExpExecArray | null
  while ((cm = callRe.exec(body)) !== null) {
    const quote = cm[1] ?? ""
    const start = cm.index + cm[0].length
    const end = scanString(body, start, quote)
    if (end < 0) continue // unterminated — the sandbox parse will reject it
    const ref = body.slice(start, end)
    if (quote === "`" && ref.includes("${")) continue
    if (!resolves(ref, cwd)) {
      errors.push({
        code: "missing-workflow-ref",
        message: `workflow("${ref}") resolves to no file or registry workflow`,
        line: lineOf(body, cm.index),
      })
    }
  }

  // 2. while(true)/for(;;) loops containing agent() never terminate on their own — with paid
  //    agents inside, that is a runaway bill unless an inner break/return was intended (which
  //    deserves a comment). Bounded patterns (loop-until-dry, loop-until-budget) are untouched.
  const loopRe = /\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/g
  let lm: RegExpExecArray | null
  while ((lm = loopRe.exec(body)) !== null) {
    const tail = body.slice(lm.index, lm.index + 2000)
    if (/\bagent\s*\(/.test(tail)) {
      warnings.push({
        code: "unbounded-loop",
        message: "unbounded loop containing agent() — confirm an inner break/return bounds it, or add a budget guard",
        line: lineOf(body, lm.index),
      })
    }
  }

  // 3. phase("Title") with a literal title missing from meta.phases renders outside the plan
  //    (usually a typo). Declared-but-unused phases are NOT flagged — conditional phases
  //    are a legitimate pattern.
  const declared = new Set(
    (parsed.meta.phases ?? [])
      .filter((p) => typeof p?.title === "string" && p.title.length > 0)
      .map((p) => p.title as string),
  )
  if (declared.size > 0) {
    const phaseRe = /\bphase\s*\(\s*(["'`])/g
    let pm: RegExpExecArray | null
    const seen = new Set<string>()
    while ((pm = phaseRe.exec(body)) !== null) {
      const quote = pm[1] ?? ""
      const start = pm.index + pm[0].length
      const end = scanString(body, start, quote)
      if (end < 0) continue
      const title = body.slice(start, end)
      if (quote === "`" && title.includes("${")) continue
      if (!declared.has(title) && !seen.has(title)) {
        seen.add(title)
        warnings.push({
          code: "undeclared-phase",
          message: `phase("${title}") is not in meta.phases — renders outside the plan (typo, or add it)`,
          line: lineOf(body, pm.index),
        })
      }
    }
  }

  return { errors, warnings }
}

/** Does a workflow() ref resolve to a file or a registry name? */
function resolves(ref: string, cwd: string): boolean {
  if (ref.includes("/") || ref.endsWith(".js")) {
    try {
      return existsSync(resolve(cwd, ref))
    } catch {
      return false
    }
  }
  try {
    resolveWorkflowName(ref, cwd)
    return true
  } catch {
    return false
  }
}

/** Index of the closing quote starting after `start` (-1 if unterminated). No interpolation. */
function scanString(body: string, start: number, quote: string): number {
  for (let i = start; i < body.length; i++) {
    const c = body[i]
    if (c === "\\") {
      i++
      continue
    }
    if (c === quote) return i
    if (c === "\n" && quote !== "`") return -1
  }
  return -1
}

function lineOf(body: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < body.length; i++) if (body[i] === "\n") line++
  return line
}
