/** Batches transport backlog after startup/reconnect, while delivering new events immediately. */
export class DurableEventReplayBuffer<T> {
  private replaying = true
  private readonly buffered: T[] = []
  private readonly maxBatchSize: number

  constructor(options: { maxBatchSize?: number } = {}) {
    this.maxBatchSize = options.maxBatchSize ?? 64
    if (!Number.isSafeInteger(this.maxBatchSize) || this.maxBatchSize < 1) {
      throw new Error('maxBatchSize must be a positive integer')
    }
  }

  begin(): void {
    this.replaying = true
  }

  async deliver(value: T, pending: number, publish: (values: T[]) => void | Promise<void>): Promise<void> {
    if (!this.replaying) {
      await publish([value])
      return
    }
    this.buffered.push(value)
    if (pending > 0 && this.buffered.length < this.maxBatchSize) return
    await publish([...this.buffered])
    this.buffered.length = 0
    this.replaying = pending > 0
  }
}
