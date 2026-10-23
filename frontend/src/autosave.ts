// Serializes writes and coalesces new requests while a transaction is in flight.
// The provider runs when a write starts, so a queued request never saves stale UI.
export class AutosaveQueue {
  private pending = false
  private running: Promise<void> | null = null
  private disposed = false
  constructor(private save: () => Promise<void>) {}
  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.pending = true
    if (!this.running) this.running = this.drain().finally(() => { this.running = null })
    return this.running
  }
  private async drain() {
    while (this.pending && !this.disposed) { this.pending = false; await this.save() }
  }
  dispose() { this.disposed = true; this.pending = false }
}
