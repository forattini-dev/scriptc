// @rust-only
// @no-engine
// A protected spread snapshots before await; rejection and resumed throws skip tail.
const events: string[] = [];
async function mutate(source: number[], mode: number): Promise<number> {
  events.push("await:start");
  await Promise.resolve();
  source[0] = 99;
  events.push("await:end");
  if (mode === 1) throw new Error("rejected spread");
  return 8;
}
function tail(mode: number): number {
  events.push("tail");
  if (mode === 2) throw new Error("resumed spread throw");
  return 9;
}
async function build(mode: number): Promise<void> {
  const source: number[] = [1];
  try {
    const values: unknown[] = [...source, await mutate(source, mode), tail(mode)];
    values.push("done");
    console.log(JSON.stringify(values), source[0]);
  } catch (error) {
    events.push("catch");
    console.log(String(error));
  } finally { events.push("finally"); }
  console.log(events.join(","));
}
for (const mode of [0, 1, 2]) {
  await build(mode);
  events.length = 0;
}
export {};
