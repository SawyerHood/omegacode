// Ambient declarations for workflow file authors. Reference this from a workflow file with:
//   /// <reference types="agent-workflows/ambient" />
// to get editor types for the injected globals (the file runs in a sandbox with no imports).

import type { AgentOpts, PipelineStage } from "./types.js"

declare global {
  /** Run one agent turn (Codex or Claude Code, per opts.provider). Returns final text, or a
   *  validated object when opts.schema is set. */
  function agent<T = string>(prompt: string, opts?: AgentOpts): Promise<T>

  /** Run thunks concurrently (under the cap) and await all. Wrap each call: () => agent(...). */
  function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>

  /** Stream each item through all stages independently (no barrier). Stages get (prev, item, i). */
  function pipeline(items: unknown[], ...stages: PipelineStage[]): Promise<unknown[]>

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
}

export {}
