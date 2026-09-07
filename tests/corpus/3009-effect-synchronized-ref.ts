// @rust-only
import { Effect, SynchronizedRef } from "effect";

const cell = Effect.runSync(SynchronizedRef.make(0));
const delayed = (value: number): Effect.Effect<number> => Effect.promise(() =>
  new Promise<number>((resolve) => setTimeout(() => resolve(value + 1), 5)));

// Two fibers run concurrently even without Effect.all's concurrency option.
// The second update must read the first update's committed value.
const first = Effect.runPromise(SynchronizedRef.updateEffect(cell, delayed));
const second = Effect.runPromise(SynchronizedRef.updateEffect(cell, (value) => Effect.succeed(value + 1)));
await Promise.all([first, second]);
console.log(Effect.runSync(SynchronizedRef.get(cell)));

const factory = SynchronizedRef.make(0);
const left = Effect.runSync(factory);
const right = Effect.runSync(factory);
Effect.runSync(SynchronizedRef.set(left, 10));
console.log(Effect.runSync(SynchronizedRef.get(right)));
const immediate = SynchronizedRef.makeUnsafe(3);
console.log(Effect.runSync(SynchronizedRef.updateAndGet(immediate, (value) => value + 4)));

// Ordinary writes on a synchronized ref must acquire the same guard.
const suspended = Effect.runPromise(SynchronizedRef.updateEffect(cell, delayed));
const set = Effect.runPromise(SynchronizedRef.set(cell, 20));
const update = Effect.runPromise(SynchronizedRef.update(cell, (value) => value + 2));
await Promise.all([suspended, set, update]);
console.log(Effect.runSync(SynchronizedRef.get(cell)));

// Failure leaves the previous value intact and releases the guard.
const failed = SynchronizedRef.updateEffect(cell, () => Effect.fail("refused"));
console.log(await Effect.runPromise(Effect.catch(failed, (error) => Effect.succeed(error))));
await Effect.runPromise(SynchronizedRef.updateEffect(cell, delayed));
console.log(Effect.runSync(SynchronizedRef.get(cell)));
