function* words(): Generator<string, void, unknown> {
  yield "first";
  yield "second";
}

function collect(values: Iterable<string>): string {
  const seen: string[] = [];
  for (const value of values) seen.push(value);
  return seen.join(",");
}

console.log(collect(words()));
