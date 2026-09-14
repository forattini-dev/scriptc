const events: string[] = [];

class Resource {
  [Symbol.dispose](): void {
    events.push("closed");
  }
}

class ThrowingResource {
  [Symbol.dispose](): void {
    throw new Error("dispose failed");
  }
}

function* values(): Generator<number, number, void> {
  using resource = new Resource();
  yield 1;
  return 2;
}

const iterator = values();
console.log(iterator.next().value);
console.log(iterator.return(7).value);
console.log(events.join(","));

function* failing(): Generator<number, number, void> {
  using resource = new ThrowingResource();
  yield 1;
  return 2;
}

const bad = failing();
bad.next();
try {
  bad.return(7);
} catch (error) {
  if (error instanceof Error) console.log(error.name, error.message);
}
