// @rust-only
// The kernel's Deferred (a latch every awaiting fiber resumes on) and Semaphore (permits over the same queue),
// plus `return yield* effect` — the gen tail the state machine now compiles.
import { Deferred, Effect, Ref, Semaphore } from "effect";

const settled = Effect.gen(function* () {
  const latch = yield* Deferred.make<number>();
  const before = yield* Deferred.isDone(latch);
  const first = yield* Deferred.succeed(latch, 7);
  const again = yield* Deferred.succeed(latch, 9);
  const value = yield* Deferred.await(latch);
  const done = yield* Deferred.isDone(latch);
  console.log(before, first, again, value, done);
  return yield* Deferred.await(latch);
});
console.log(Effect.runSync(settled));

const guarded = Effect.gen(function* () {
  const permits = yield* Semaphore.make(2);
  const log = yield* Ref.make("");
  const step = (name: string) =>
    permits.withPermits(1)(Effect.gen(function* () {
      yield* Ref.update(log, (s) => s + name);
    }));
  yield* step("a");
  yield* step("b");
  const seen = yield* Ref.get(log);
  return seen;
});
console.log(Effect.runSync(guarded));
