/** Минимальная асинхронная очередь: продюсер пишет, потребитель читает через for await. */
export class Channel<T> {
  private queue: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const next = this.resolvers.shift();
    if (next) next({ value, done: false });
    else this.queue.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.resolvers) r({ value: undefined as never, done: true });
    this.resolvers = [];
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.queue.length) {
        yield this.queue.shift() as T;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
