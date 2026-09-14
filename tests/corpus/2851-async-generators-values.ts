// Async generators as declarations, generic instantiations, function
// expressions, object methods, public class methods, and private methods.
class Source {
  private start: number;

  constructor(start: number) {
    this.start = start;
  }

  async *values(): AsyncGenerator<number, void, undefined> {
    yield this.start;
    await Promise.resolve();
    yield this.start + 1;
  }

  async *#privateValues(): AsyncGenerator<string, void, undefined> {
    yield "private";
  }

  async showPrivate(): Promise<void> {
    for await (const value of this.#privateValues()) console.log(value);
  }
}

async function* generic<T>(value: T): AsyncGenerator<T, void, undefined> {
  yield value;
}

async function* inferred() {
  yield 11;
}

const object = {
  async *values(): AsyncGenerator<number, void, undefined> {
    yield 9;
  },
};

const expression = async function* (): AsyncGenerator<string, void, undefined> {
  yield "expression";
};

async function main(): Promise<void> {
  for await (const value of new Source(4).values()) console.log(value);
  await new Source(0).showPrivate();
  console.log(JSON.stringify(await generic("generic").next()));
  console.log(JSON.stringify(await generic(7).next()));
  console.log(JSON.stringify(await inferred().next()));
  console.log(JSON.stringify(await object.values().next()));
  console.log(JSON.stringify(await expression().next()));
}

void main();
