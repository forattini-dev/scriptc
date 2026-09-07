// @rust-only
import { Effect, PubSub } from "effect";

const bounded = Effect.runSync(PubSub.bounded<number>(1));
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const old = yield* PubSub.subscribe(bounded);
  yield* PubSub.publish(bounded, 1);
  const second = Effect.runPromise(PubSub.publish(bounded, 2));
  const third = Effect.runPromise(PubSub.publish(bounded, 3));
  // Membership at admission includes a subscriber joining while full.
  const joined = yield* PubSub.subscribe(bounded);
  const one = yield* PubSub.take(old);
  yield* Effect.promise(() => second);
  const two = yield* PubSub.take(old);
  const alsoTwo = yield* PubSub.take(joined);
  yield* Effect.promise(() => third);
  const three = yield* PubSub.take(old);
  const alsoThree = yield* PubSub.take(joined);
  console.log("fifo", one, two, alsoTwo, three, alsoThree);
})));

// Closing the last subscription admits blocked publishers without retaining
// their messages for future subscriptions.
const released = Effect.runSync(PubSub.bounded<number>(1));
const publication = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  yield* PubSub.subscribe(released);
  yield* PubSub.publish(released, 1);
  return { pending: Effect.runPromise(PubSub.publish(released, 2)) };
})));
console.log("released", await publication.pending);
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fresh = yield* PubSub.subscribe(released);
  yield* PubSub.publish(released, 3);
  const value = yield* PubSub.take(fresh);
  console.log("fresh", value);
})));

// Sliding evicts only the oldest shared message, preserving messages a
// faster subscriber has not yet read.
const sliding = Effect.runSync(PubSub.sliding<number>(2));
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const fast = yield* PubSub.subscribe(sliding);
  const slow = yield* PubSub.subscribe(sliding);
  yield* PubSub.publish(sliding, 1);
  yield* PubSub.publish(sliding, 2);
  const one = yield* PubSub.take(fast);
  yield* PubSub.publish(sliding, 3);
  const fastTwo = yield* PubSub.take(fast);
  const fastThree = yield* PubSub.take(fast);
  const slowTwo = yield* PubSub.take(slow);
  const slowThree = yield* PubSub.take(slow);
  console.log("sliding", one, fastTwo, fastThree, slowTwo, slowThree);
})));
