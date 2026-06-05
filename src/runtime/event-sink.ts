// FileEventSink: appends WorkflowEvents to runs/<runId>/events.jsonl (the observability log the
// terminal renderer and the viewer server both read). Stamps each event with `t` (ms).

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs"
import { join } from "node:path"
import type { EventSink, WorkflowEvent, WorkflowEventInput } from "./events.js"
import { runDir } from "./journal.js"

export type EventListener = (event: WorkflowEvent) => void

export class FileEventSink implements EventSink {
  private readonly stream: WriteStream
  private readonly listeners: EventListener[]
  private readonly clock: () => number

  constructor(runId: string, opts: { listeners?: EventListener[]; clock?: () => number } = {}) {
    const dir = runDir(runId)
    mkdirSync(dir, { recursive: true })
    this.stream = createWriteStream(join(dir, "events.jsonl"), { flags: "a" })
    this.listeners = opts.listeners ?? []
    // Wall-clock for the observability log is fine (it is NOT part of resume determinism).
    this.clock = opts.clock ?? (() => globalThis.Date.now())
  }

  emit(event: WorkflowEventInput): void {
    const full = { ...event, t: this.clock() } as WorkflowEvent
    this.stream.write(JSON.stringify(full) + "\n")
    for (const l of this.listeners) l(full)
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve))
  }
}

/** A no-op sink (tests / --no-events). */
export class NullEventSink implements EventSink {
  emit(): void {}
  close(): Promise<void> {
    return Promise.resolve()
  }
}
