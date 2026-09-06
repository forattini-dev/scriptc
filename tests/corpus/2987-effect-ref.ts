// @rust-only
// The kernel's Ref and SynchronizedRef: one mutable cell, read and written inside effects.
import { Effect, Ref, SynchronizedRef } from "effect";

const program = Effect.gen(function* () {
  const counter = yield* Ref.make(0);
  yield* Ref.set(counter, 10);
  yield* Ref.update(counter, (n) => n + 5);
  const seen = yield* Ref.getAndSet(counter, 99);
  const after = yield* Ref.get(counter);
  const next = yield* Ref.updateAndGet(counter, (n) => n * 2);
  return `${seen} ${after} ${next}`;
});
console.log(Effect.runSync(program));

const names = Effect.gen(function* () {
  const cell = yield* SynchronizedRef.make("a");
  yield* SynchronizedRef.update(cell, (s) => s + "b");
  yield* SynchronizedRef.updateEffect(cell, (s) => Effect.succeed(s + "c"));
  const all = yield* SynchronizedRef.get(cell);
  return all;
});
console.log(Effect.runSync(names));

const unsafe = Ref.makeUnsafe(3);
console.log(Effect.runSync(Effect.uninterruptible(Ref.get(unsafe))));

const shared = Effect.gen(function* () {
  const total = yield* Ref.make(0);
  yield* Effect.forEach([1, 2, 3, 4], (n) => Ref.update(total, (sum) => sum + n), { discard: true });
  const sum = yield* Ref.get(total);
  return sum;
});
console.log(Effect.runSync(shared));
