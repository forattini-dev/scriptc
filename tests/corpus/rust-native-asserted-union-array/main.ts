interface EmbedOptions {
  readonly input: string | string[];
}

function requests(options: EmbedOptions): string[] {
  const isBatch = Array.isArray(options.input);
  const inputs = isBatch ? options.input : [options.input];
  return (inputs as string[]).map((text) => `models/${text}`);
}

console.log(JSON.stringify(requests({ input: "one" })));
console.log(JSON.stringify(requests({ input: ["a", "b", "c"] })));

function first(value: number | number[]): number {
  const list = Array.isArray(value) ? value : [value];
  return (list as number[])[0] ?? -1;
}

console.log(first(7), first([3, 4]), first([]));

interface BatchOptions {
  readonly input: string | string[];
}

function batch(options: BatchOptions): string[] {
  const isBatch = Array.isArray(options.input);
  const inputs = isBatch ? options.input : [options.input];
  return (inputs as string[]).map((text, index) => `${index}:${text}`);
}

console.log(JSON.stringify(batch({ input: "solo" })), JSON.stringify(batch({ input: ["p", "q"] })));
