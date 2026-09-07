export class MutationQueue {
  private chain: Promise<unknown> = Promise.resolve();
  busy = false;
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.busy = true; // 在入队时同步置位，否则 busy 要等微任务才生效（brief 自带测试要求同步可见）
    const next = this.chain.then(async () => {
      try { return await fn(); }
      finally { this.busy = false; }
    });
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
}
