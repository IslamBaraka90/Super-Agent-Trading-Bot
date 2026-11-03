/** Counting semaphore: caps how many worker turns run at the same time. */
export class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;

  constructor(private readonly permits: number) {}

  get inUse(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.permits) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiting.shift();
      if (next) next();
    };
  }
}
