// @rust-only
import { Effect, Ref, SynchronizedRef } from "effect";

let calls = 0;
const initial = (n: number): number => n + 1;
const replacement = (n: number): number => {
  calls += 1;
  return n * 3;
};
const cell = Ref.makeUnsafe(initial);
const previous = Effect.runSync(Ref.getAndSet(cell, replacement));
console.log(calls, previous(4));
const current = Effect.runSync(Ref.get(cell));
console.log(current(4), calls);

const synced = Effect.runSync(SynchronizedRef.make(initial));
const old = Effect.runSync(SynchronizedRef.getAndSet(synced, replacement));
console.log(calls, old(5));
const next = Effect.runSync(SynchronizedRef.get(synced));
console.log(next(5), calls);
