function probe(value: number): number {
  console.log(`case:${value}`);
  return value;
}
async function choose(value: number): Promise<string> {
  switch (value) {
    case probe(1): return Promise.resolve("one");
    default: return Promise.resolve("default");
    case probe(2): return Promise.resolve("two");
  }
}
async function main(): Promise<void> {
  const values = await Promise.all([choose(1), choose(2), choose(3)]);
  console.log(values.join(","));
}
void main();
