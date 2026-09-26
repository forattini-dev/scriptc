class Counter {
  private current = 0;
  private readonly limit: number;
  closed = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  [Symbol.asyncIterator](): Counter {
    console.log("open");
    return this;
  }

  async next(): Promise<{ value: number; done: boolean }> {
    await Promise.resolve();
    const done = this.current >= this.limit;
    const value = done ? -1 : this.current++;
    console.log("next", value, done);
    return { value, done };
  }

  async return(): Promise<{ value: number; done: boolean }> {
    this.closed = true;
    console.log("close");
    return { value: -1, done: true };
  }
}

async function breakCloses(): Promise<void> {
  const counter = new Counter(3);
  for await (const value of counter) {
    console.log("break value", value, typeof value);
    break;
  }
  console.log("break state", counter.closed);
}

async function exhaustsWithoutClose(): Promise<void> {
  const counter = new Counter(2);
  for await (const value of counter) {
    console.log("all value", value);
  }
  console.log("all state", counter.closed);
}

async function returnFromLoop(counter: Counter): Promise<void> {
  for await (const value of counter) {
    console.log("return value", value);
    return;
  }
}

async function returnCloses(): Promise<void> {
  const counter = new Counter(2);
  await returnFromLoop(counter);
  console.log("return state", counter.closed);
}

async function main(): Promise<void> {
  await breakCloses();
  await exhaustsWithoutClose();
  await returnCloses();
}

void main();
