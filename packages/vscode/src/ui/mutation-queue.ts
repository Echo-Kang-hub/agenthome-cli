export class MutationQueue {
  private chain: Promise<unknown> = Promise.resolve();
  busy = false;
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.busy = true; // 入队即置位（同步可见，brief 自带测试要求）
    const next = this.chain.then(async () => {
      this.busy = true; // 队列后项开始执行时重新置位，防止前项 finally 误清
      try { return await fn(); }
      finally { this.busy = false; }
    });
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
}
