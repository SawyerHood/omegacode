/** A minimal FIFO async semaphore: at most `limit` holders at once. */
export class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++
      return this.release()
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    return this.release()
  }

  private release(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      const next = this.queue.shift()
      if (next) next()
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
