import { AgentError, type Worker } from "./index.js"
import type { ProviderId } from "../dsl/types.js"

export interface RetryOptions {
  attempts?: number
  baseMs?: number
  maxMs?: number
}

/** Run `fn`, retrying on retryable AgentErrors with exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4
  const base = opts.baseMs ?? 1000
  const max = opts.maxMs ?? 30_000
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!(err instanceof AgentError) || !err.retryable || i === attempts - 1) throw err
      const delay = Math.min(max, base * 2 ** i)
      await sleep(delay, signal)
    }
  }
  throw lastErr
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t)
        reject(new Error("aborted"))
      },
      { once: true },
    )
  })
}

export function notImplemented(provider: ProviderId): Worker {
  return {
    id: provider,
    async runAgent() {
      throw new AgentError({ provider, code: "not_implemented", message: `${provider} worker is not implemented yet` })
    },
    async shutdown() {},
  }
}
