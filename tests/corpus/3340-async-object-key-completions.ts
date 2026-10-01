// @rust-only
// @no-engine
// Computed keys precede awaited values; rejection and resumed throws run finally.
const events: string[] = [];
async function key(): Promise<string> {
  events.push("key:start");
  await Promise.resolve();
  events.push("key:end");
  return "chosen";
}
async function value(mode: number): Promise<number> {
  events.push("value:start");
  await Promise.resolve();
  events.push("value:end");
  if (mode === 1) throw new Error("rejected value");
  return 4;
}
function tail(mode: number): number {
  events.push("tail");
  if (mode === 2) throw new Error("resumed throw");
  return 5;
}
async function build(mode: number): Promise<{ [key: string]: number }> {
  try {
    return { [await key()]: await value(mode), tail: tail(mode) };
  } catch (error) {
    console.log(String(error));
    events.push("catch");
    return { caught: 9 };
  } finally { events.push("finally"); }
}
for (const mode of [0, 1, 2]) {
  const result = await build(mode);
  console.log(Object.keys(result).join(","), JSON.stringify(result));
  console.log(events.join(","));
  events.length = 0;
}
export {};
