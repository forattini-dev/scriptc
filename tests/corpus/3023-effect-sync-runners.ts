// @rust-only
import { Deferred, Effect, Exit } from "effect";

const events: string[] = [];
const gate = Effect.runSync(Deferred.make<number>());
const work = Effect.ensuring(Effect.gen(function* () {
  const value = yield* Deferred.await(gate);
  events.push(`body:${value}`);
  return value;
}), Effect.sync(() => { events.push("cleanup"); }));

// runSyncExit returns an immutable failure snapshot, without cancelling work.
const pending = Effect.runSyncExit(work);
console.log(pending._tag, Exit.isFailure(pending), events.join(","));
Effect.runSync(Deferred.succeed(gate, 7));
console.log(pending._tag, events.join(","));

const second = Effect.runSync(Deferred.make<number>());
try {
  Effect.runSync(Effect.ensuring(Deferred.await(second), Effect.sync(() => { events.push("second cleanup"); })));
} catch (error) {
  if (error instanceof Error) console.log(error.name, error.message);
}
console.log(events.join(","));
Effect.runSync(Deferred.succeed(second, 9));
console.log(events.join(","));

const success = Effect.runSyncExit(Effect.succeed(42));
console.log(success._tag, Exit.isSuccess(success) ? success.value : 0);
console.log(Effect.runSyncExit(Effect.fail("typed"))._tag);
console.log(Effect.runSyncExit(Effect.die("defect"))._tag);
console.log(Effect.runSyncExit(Effect.sync(() => { throw "thrown"; }))._tag);

// Nonpositive/NaN durations are already complete in Effect 4.
for (const duration of [0, -1, NaN]) console.log(Effect.runSyncExit(Effect.sleep(duration))._tag);
console.log(Effect.runSyncExit(Effect.sleep("0 millis"))._tag);
console.log(Effect.runSyncExit(Effect.sleep(1))._tag);
await new Promise<void>((resolve) => setTimeout(resolve, 10));
