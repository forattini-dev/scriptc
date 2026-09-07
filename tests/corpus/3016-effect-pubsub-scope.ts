// @rust-only
import { Cause, Effect, PubSub } from "effect";

const describe = (effect: Effect.Effect<number>): Effect.Effect<string> =>
  Effect.catchCause(Effect.map(effect, (n) => `value:${n}`), (cause) =>
    Effect.succeed(`${Cause.hasDies(cause)}:${Cause.hasInterrupts(cause)}:${Cause.hasInterruptsOnly(cause)}`));

const hub = Effect.runSync(PubSub.unbounded<number>());
// A handle may escape, but its subscription ends with its acquiring scope.
const expired = Effect.runSync(Effect.scoped(Effect.gen(function* () {
  const sub = yield* PubSub.subscribe(hub);
  yield* PubSub.publish(hub, 7);
  return sub;
})));
console.log(await Effect.runPromise(describe(PubSub.take(expired))));

// Closing an inner subscription does not close the outer subscription.
console.log(await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const outer = yield* PubSub.subscribe(hub);
  yield* Effect.scoped(PubSub.subscribe(hub));
  yield* PubSub.publish(hub, 9);
  return yield* PubSub.take(outer);
}))));

// A hub shutdown interrupts pending takes and runs their finalizers.
const events: string[] = [];
const waiting = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const sub = yield* PubSub.subscribe(hub);
  return yield* describe(Effect.ensuring(PubSub.take(sub), Effect.sync(() => { events.push("released"); })));
})));
await Effect.runPromise(PubSub.shutdown(hub));
console.log(await waiting);
console.log(events.join(","));
console.log(await Effect.runPromise(PubSub.publish(hub, 11)));
