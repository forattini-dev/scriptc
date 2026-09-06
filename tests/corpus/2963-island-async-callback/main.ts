// @dynamic
// @rust-only
// @island-module: ./events.ts
// Async static callbacks handed to an island module: their native promise
// crosses as an engine promise the island awaits; a rejection reaches the
// island as an Error with the reason's message.
import { run, fails, withArgv } from "./events.ts";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
console.log(await run(async (n: number) => {
  await wait(1);
  return "v" + String(n * 10);
}));
console.log(await fails(async (n: number) => {
  await wait(1);
  if (n < 0) throw new Error("negative " + String(n));
  return "ok";
}));
console.log(await withArgv(async (argv: unknown) => {
  await wait(1);
  return { extra: (argv as { mode: string }).mode.length };
}));
