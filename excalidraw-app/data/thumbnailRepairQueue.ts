/** Only visible cards enqueue work; cancellation removes queued closures immediately. */
export class ThumbnailRepairQueue {
  private pending = new Set<() => Promise<void>>();
  private active = false;

  schedule(run: () => Promise<void>) {
    this.pending.add(run);
    void this.drain();
    return () => {
      this.pending.delete(run);
    };
  }

  private async drain() {
    if (this.active) {
      return;
    }
    this.active = true;
    try {
      while (this.pending.size) {
        const run = this.pending.values().next().value!;
        this.pending.delete(run);
        try {
          await run();
        } catch {
          // A failed card must not prevent other visible cards from rendering.
        }
      }
    } finally {
      this.active = false;
    }
  }
}
