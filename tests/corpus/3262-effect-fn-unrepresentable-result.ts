// @rust-only
// Effect.fn generator bodies whose RETURN channel has no IteratorResult record
// (a Map, a function): the effect kernel drives the generator natively, so the
// body compiles instead of crashing the lowering that builds that record.
import { Effect } from "effect";

const tally = Effect.fn("tally")(function* (word: string) {
  const one = yield* Effect.succeed(1);
  const counts = new Map<string, number>();
  counts.set(word, one);
  counts.set("other", one + 1);
  return counts;
});

const adder = Effect.fn("adder")(function* (base: number) {
  const offset = yield* Effect.succeed(base * 2);
  return (value: number): number => value + offset;
});

const counts = Effect.runSync(tally("a"));
console.log(counts.size, counts.get("a"), counts.get("other"));
const add = Effect.runSync(adder(5));
console.log(add(1), add(10));
