// @rust-only
// @no-engine
export {};

class TaggedThenable<T> implements PromiseLike<T> {
  private readonly promise: Promise<T>;

  constructor(promise: Promise<T>) {
    this.promise = promise;
  }

  get [Symbol.toStringTag](): string {
    return "TaggedThenable";
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    yield await this.promise;
  }
}

class Client {
  get<T = unknown>(): TaggedThenable<T> {
    return new TaggedThenable(Promise.resolve("symbol-ok" as T));
  }
}

async function main(): Promise<void> {
  const value = await new Client().get<string>();
  console.log(value);
}

main();
