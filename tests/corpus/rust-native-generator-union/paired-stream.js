function* decodeSync(source) {
  for (const value of source) {
    yield { type: "value", value };
  }
}

async function* decodeAsync(source) {
  for await (const value of source) {
    yield { type: "value", value };
  }
}

export function decodeFromLines(source) {
  return Symbol.asyncIterator in source ? decodeAsync(source) : decodeSync(source);
}
