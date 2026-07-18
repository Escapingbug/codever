/** Batches transport backlog after startup/reconnect, while delivering new events immediately. */
export class DurableEventReplayBuffer<T> {
  private replaying = true
  private readonly buffered: T[] = []

  begin(): void {
    this.replaying = true
  }

  async deliver(value: T, pending: number, publish: (values: T[]) => void | Promise<void>): Promise<void> {
    if (!this.replaying) {
      await publish([value])
      return
    }
    this.buffered.push(value)
    if (pending > 0) return
    await publish([...this.buffered])
    this.buffered.length = 0
    this.replaying = false
  }
}
