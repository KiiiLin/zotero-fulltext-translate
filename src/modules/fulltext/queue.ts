export type QueueOutcome = "complete" | "paused" | "failed";
interface Entry<T> {
  item: T;
  cancelled: boolean;
}
interface QueueHooks<T> {
  queued(item: T): void;
  cancelActive(item: T): void;
  settled(item: T, outcome: QueueOutcome, error?: unknown): void;
}

/** One document at a time, including SDT extraction, with deduplication until settled. */
export class SerialTranslationQueue<T> {
  private entries = new Map<number, Entry<T>>();
  private pending: Entry<T>[] = [];
  private current?: Entry<T>;
  private draining = false;
  private closed = false;
  constructor(
    private key: (item: T) => number,
    private run: (
      item: T,
      cancelled: () => boolean,
    ) => Promise<"complete" | "paused">,
    private hooks: QueueHooks<T>,
  ) {}
  has(id: number) {
    return this.entries.has(id);
  }
  add(items: T[]): number {
    if (this.closed) return 0;
    let added = 0;
    for (const item of items) {
      const id = this.key(item);
      if (this.entries.has(id)) continue;
      const entry = { item, cancelled: false };
      this.entries.set(id, entry);
      this.pending.push(entry);
      this.hooks.queued(item);
      added++;
    }
    // Register the whole selection before starting its first document.
    void Promise.resolve().then(() => this.drain());
    return added;
  }
  cancel(id: number) {
    const entry = this.entries.get(id);
    if (!entry || entry.cancelled) return;
    entry.cancelled = true;
    if (entry === this.current) this.hooks.cancelActive(entry.item);
    else {
      this.pending = this.pending.filter((value) => value !== entry);
      this.entries.delete(id);
      this.hooks.settled(entry.item, "paused");
    }
  }
  close() {
    this.closed = true;
    for (const id of [...this.entries.keys()]) this.cancel(id);
  }
  private async drain() {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (!this.closed && this.pending.length) {
        const entry = this.pending.shift()!;
        this.current = entry;
        let outcome: QueueOutcome = "paused",
          error: unknown;
        try {
          outcome = await this.run(
            entry.item,
            () => entry.cancelled || this.closed,
          );
        } catch (failure) {
          outcome = "failed";
          error = failure;
        } finally {
          this.entries.delete(this.key(entry.item));
          this.current = undefined;
        }
        this.hooks.settled(entry.item, outcome, error);
      }
    } finally {
      this.draining = false;
    }
  }
}
