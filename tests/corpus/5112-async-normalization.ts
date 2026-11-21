function mark(value: string): string { console.log(value); return value; }
function combine(first: string, second: string): string { return first + second; }
async function pair(): Promise<string> {
  const [a, b] = await Promise.all([Promise.resolve("a"), Promise.resolve("b")]);
  return a + b;
}
async function nullable(): Promise<string | null> {
  try { return await Promise.reject(new Error("no")); }
  catch { return null; }
}
async function branch(active: boolean): Promise<string> {
  const value = active ? (await nullable()) ?? "fallback" : mark("inactive");
  return value;
}
async function argumentsOrder(): Promise<string> {
  const value = combine(mark("first"), await Promise.resolve(mark("second")));
  return value;
}
function first(values: string[]): string { return values[0]; }
async function nestedArrayArgument(): Promise<string> {
  return first([await Promise.resolve("nested")]);
}
async function asyncFinally(): Promise<string> {
  let suffix = "";
  try {
    return await Promise.resolve("value");
  } finally {
    suffix = await Promise.resolve("finally");
    console.log(suffix);
  }
}
async function main(): Promise<void> {
  const values = await Promise.all([
    pair(), branch(true), branch(false), argumentsOrder(), nestedArrayArgument(), asyncFinally(),
  ]);
  console.log(values.join(","));
}
void main();
