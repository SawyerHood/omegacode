// Ambient declarations for workflow file authors. Reference this from a workflow file with:
//   /// <reference types="omegacode/ambient" />
// to get editor types for the injected globals (the file runs in a sandbox with no imports).
//
// This file is SELF-CONTAINED on purpose: it ships in the published tarball at a stable path and
// must not import any module that isn't also published. The option types below are inlined copies
// of the ones in ./types.ts; keep them in sync (a packaging test asserts the union members).

declare global {
  type OmegacodeProviderId = "codex" | "claude-code" | "opencode" | "pi" | "muse"

  type OmegacodeSandbox = "read-only" | "workspace-write" | "danger-full-access"

  type OmegacodeEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

  type OmegacodeApproval = "never" | "on-request"

  type OmegacodeJSONSchema = Record<string, unknown>

  /** Options an author passes to `agent()`. All optional; defaults come from meta/config/CLI. */
  interface OmegacodeAgentBaseOpts {
    label?: string
    phase?: string
    effort?: OmegacodeEffort
    cwd?: string
    sandbox?: OmegacodeSandbox
    approval?: OmegacodeApproval
    instructions?: string
    schema?: OmegacodeJSONSchema
    worktree?: boolean | string
    /** Pin a stable resume cache key; otherwise the chained key is used. */
    key?: string
    /** Hard cap on agent turns (provider-enforced where supported). */
    maxTurns?: number
  }

  /** provider and model travel together (both-or-neither): a lone provider would inherit a model
   *  meant for a different provider from the run defaults. Set both, or omit both. */
  type OmegacodeAgentOpts = OmegacodeAgentBaseOpts &
    ({ provider: OmegacodeProviderId; model: string } | { provider?: never; model?: never })

  type OmegacodePipelineStage = (
    prev: unknown,
    item: unknown,
    index: number,
  ) => unknown | Promise<unknown>

  /** Run one agent turn (Codex or Claude Code, per opts.provider). Returns final text, or a
   *  validated object when opts.schema is set. */
  function agent<T = string>(prompt: string, opts?: OmegacodeAgentOpts): Promise<T>

  /** Run thunks concurrently (under the cap) and await all. Wrap each call: () => agent(...). */
  function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>

  /** Stream each item through all stages independently (no barrier). Stages get (prev, item, i). */
  function pipeline(items: unknown[], ...stages: OmegacodePipelineStage[]): Promise<unknown[]>

  /** Open a named progress group; subsequent agent() calls render under it. */
  function phase(title: string): void

  /** Emit a narrator line to the progress UI. */
  function log(msg: string): void

  /** Journal-seeded clock (use instead of Date.now(), which throws). */
  function now(): number

  /** Journal-seeded RNG (use instead of Math.random(), which throws). */
  function random(): number

  /** Token budget for the run: `{ total: number|null, spent(): number, remaining(): number }`. */
  const budget: { total: number | null; spent(): number; remaining(): number }

  /** The CLI-supplied input (--args '<json>'); undefined if not passed. */
  const args: unknown

  /** Run a saved workflow inline (one level deep) and return its result. */
  function workflow<T = unknown>(ref: string, args?: unknown, opts?: { schema?: OmegacodeJSONSchema }): Promise<T>
}

export {}
