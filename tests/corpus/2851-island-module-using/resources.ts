const named = (log: string[], name: string): Disposable => ({
  [Symbol.dispose]() {
    log.push(name);
  },
});

export function ordered(): string {
  const log: string[] = [];
  {
    using a = named(log, "a");
    using b = named(log, "b");
    log.push("body");
  }
  return log.join(",");
}

export function throwing(): string {
  const log: string[] = [];
  try {
    using a = named(log, "a");
    log.push("before");
    throw new Error("boom");
  } catch (e) {
    log.push("caught:" + (e as Error).message);
  }
  return log.join(",");
}

export function stacked(): string {
  const log: string[] = [];
  try {
    using stack = new DisposableStack();
    stack.defer(() => {
      throw new Error("one");
    });
    stack.defer(() => {
      throw new Error("two");
    });
    log.push("armed");
  } catch (e) {
    const s = e as { name: string; error: Error; suppressed: Error };
    log.push(`${s.name}:${s.error.message}/${s.suppressed.message}`);
  }
  return log.join(",");
}

export async function asyncOrdered(): Promise<string> {
  const log: string[] = [];
  {
    await using a = {
      async [Symbol.asyncDispose]() {
        await Promise.resolve();
        log.push("async-a");
      },
    };
    using b = named(log, "b");
    log.push("body");
  }
  return log.join(",");
}
