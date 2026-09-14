export class PromisePool<T> {
  private readonly source: IterableIterator<
    Promise<void | readonly [number, T]>
  >;
  private readonly concurrency: number;
  private readonly entries: Record<number, T> = {};

  constructor(
    source: IterableIterator<Promise<void | readonly [number, T]>>,
    concurrency: number,
  ) {
    this.source = source;
    this.concurrency = Math.max(1, Math.floor(concurrency));
  }

  public async all() {
    const worker = async () => {
      while (true) {
        const next = this.source.next();
        if (next.done) {
          return;
        }
        const result = await next.value;
        if (result) {
          const [index, value] = result;
          this.entries[index] = value;
        }
      }
    };

    await Promise.all(
      Array.from({ length: this.concurrency }, () => worker()),
    );
    return Object.values(this.entries);
  }
}
