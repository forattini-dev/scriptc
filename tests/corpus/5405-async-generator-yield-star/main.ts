class Source {
  async *items(): AsyncGenerator<string> {
    yield 'alpha';
    yield 'beta';
  }
}

class Wrapper {
  private readonly source: Source;

  constructor(source: Source) {
    this.source = source;
  }

  async *items(): AsyncGenerator<string> {
    yield* this.source.items();
  }
}

async function main(): Promise<void> {
  for await (const item of new Wrapper(new Source()).items()) {
    console.log(item);
  }
}

await main();
