type GenEvent =
  | { type: "start"; value: number }
  | { type: "end"; value: string };

function* syncEvents(): Generator<GenEvent, void, unknown> {
  yield { type: "start", value: 1 };
}

async function* asyncEvents(): AsyncGenerator<GenEvent, void, unknown> {
  yield { type: "end", value: "done" };
}

async function* protectedEvents(stop: boolean): AsyncGenerator<number, void, unknown> {
  try {
    yield await Promise.resolve(1);
    if (stop) return;
    yield await Promise.resolve(2);
  } finally {
    console.log("async cleanup", stop);
  }
}

function* guarded(stop: boolean): Generator<number, void, undefined> {
  try {
    if (stop) return;
  } finally {
    console.log("cleanup");
  }
  yield 1;
}

async function main(): Promise<void> {
  syncEvents();
  asyncEvents();
  const completed: number[] = [];
  for await (const value of protectedEvents(false)) completed.push(value);
  console.log("completed", completed.join(","));
  const stopped: number[] = [];
  for await (const value of protectedEvents(true)) stopped.push(value);
  console.log("stopped", stopped.join(","));
}

const record = { value: 1 };
console.log(true);
console.log(guarded(true).next().done);
Object.getPrototypeOf(record);
console.log(true);
void main();
