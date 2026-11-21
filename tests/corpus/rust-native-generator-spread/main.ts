function* numbers(limit: number): Generator<number, void, unknown> {
  for (let value = 1; value <= limit; value += 1) {
    console.log("yield", value);
    yield value;
  }
  console.log("done", limit);
}

const live = numbers(3);
console.log(JSON.stringify([...live]));
console.log([...live].length);

function mark(label: string): number {
  console.log("mark", label);
  return label.length;
}

console.log(JSON.stringify([mark("a"), ...numbers(2), mark("bc")]));

interface SearchOptions {
  readonly limit: number;
  readonly excludeRids?: Iterable<number>;
}

function serializable(options: SearchOptions): Record<string, unknown> {
  return {
    ...options,
    excludeRids: options.excludeRids ? [...options.excludeRids] : undefined,
  };
}

console.log(JSON.stringify(serializable({ limit: 1 })));
console.log(JSON.stringify(serializable({ limit: 2, excludeRids: numbers(2) })));

function* empty(): Generator<number, void, unknown> {
  console.log("empty body");
}
console.log([...empty()].length);
