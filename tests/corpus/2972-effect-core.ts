// @rust-only
// The effect kernel's first slice: Effect.succeed/sync/map/flatMap built
// as native descriptions and run by runSync/runPromise — no embedded
// engine, no effect JavaScript in the binary. Static build; the Node
// oracle runs the real effect package.
import { Effect } from "effect";

const doubled = Effect.map(Effect.succeed(21), (n) => n * 2);
const described = Effect.flatMap(doubled, (n) => Effect.sync(() => `answer=${n}`));
console.log(Effect.runSync(described));

const counted = Effect.map(Effect.sync(() => [1, 2, 3].length), (n) => n + 39);
console.log(Effect.runSync(counted));

async function main(): Promise<void> {
  const later = await Effect.runPromise(Effect.map(Effect.succeed("later"), (s) => `${s}!`));
  console.log(later);
}
await main();
