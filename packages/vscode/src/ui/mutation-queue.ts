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

// 命令层 mutation 模板：成功或失败都 refresh —— 失败时树/Dashboard 不得滞留旧数据（T8 Minor A）
export async function runMutation<T>(queue: MutationQueue, fn: () => Promise<T>, refresh: () => void): Promise<T> {
  try {
    return await queue.run(fn);
  } finally {
    refresh();
  }
}
