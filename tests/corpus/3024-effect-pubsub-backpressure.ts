// @rust-only
import { Cause, Effect, PubSub } from "effect";

const bounded = Effect.runSync(PubSub.bounded<number>(1));
const events: string[] = [];
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const first = yield* PubSub.subscribe(bounded);
  const second = yield* PubSub.subscribe(bounded);
  const value1 = yield* PubSub.publish(bounded, 1);
  console.log("initial", value1);
  const pending = Effect.runPromise(Effect.tap(PubSub.publish(bounded, 2), (accepted) =>
    Effect.sync(() => { events.push(`published:${accepted}`); })));
  console.log("full", events.join(","));
  const value2 = yield* PubSub.take(first);
  console.log("first", value2);
  console.log("still full", events.join(","));
  const value3 = yield* PubSub.take(second);
  console.log("second", value3);
  yield* Effect.promise(() => pending);
  console.log("resumed", events.join(","));
  const value4 = yield* PubSub.take(first);
  const value5 = yield* PubSub.take(second);
  console.log("both", value4, value5);
})));

// Dropping is atomic across subscribers, including a faster subscriber.
const dropping = Effect.runSync(PubSub.dropping<number>(1));
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fast = yield* PubSub.subscribe(dropping);
  const slow = yield* PubSub.subscribe(dropping);
  const value6 = yield* PubSub.publish(dropping, 1);
  console.log("drop first", value6);
  const value7 = yield* PubSub.take(fast);
  console.log("fast", value7);
  const value8 = yield* PubSub.publish(dropping, 2);
  console.log("dropped", value8);
  const value9 = yield* PubSub.take(slow);
  console.log("slow", value9);
  const value10 = yield* PubSub.publish(dropping, 3);
  console.log("drop third", value10);
  const value11 = yield* PubSub.take(fast);
  const value12 = yield* PubSub.take(slow);
  console.log("delivered", value11, value12);
})));

// Effect 4 shutdown releases subscriptions, admitting queued publications;
// later publishes see the shutdown flag and return false.
const closing = Effect.runSync(PubSub.bounded<number>(1));
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  yield* PubSub.subscribe(closing);
  yield* PubSub.publish(closing, 1);
  const pending = Effect.runPromise(Effect.catchCause(
    Effect.map(PubSub.publish(closing, 2), (ok) => `accepted:${ok}`),
    (cause) => Effect.succeed(`interrupted:${Cause.hasInterruptsOnly(cause)}`),
  ));
  yield* PubSub.shutdown(closing);
  const value13 = yield* Effect.promise(() => pending);
  console.log("shutdown", value13);
  const value14 = yield* PubSub.publish(closing, 3);
  console.log("closed", value14);
})));
