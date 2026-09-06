// @rust-only
// The kernel's Queue (unbounded, dropping and sliding) and PubSub (a publish reaches every subscriber's queue).
import { Effect, PubSub, Queue } from "effect";

const basics = Effect.gen(function* () {
  const q = yield* Queue.unbounded<number>();
  yield* Queue.offer(q, 1);
  yield* Queue.offer(q, 2);
  const size = yield* Queue.size(q);
  const first = yield* Queue.take(q);
  const second = yield* Queue.take(q);
  return `${size} ${first} ${second}`;
});
console.log(Effect.runSync(basics));

const dropping = Effect.gen(function* () {
  const q = yield* Queue.dropping<string>(2);
  const a = yield* Queue.offer(q, "a");
  const b = yield* Queue.offer(q, "b");
  const c = yield* Queue.offer(q, "c");
  const head = yield* Queue.take(q);
  const left = yield* Queue.size(q);
  return `${a} ${b} ${c} ${head} ${left}`;
});
console.log(Effect.runSync(dropping));

const sliding = Effect.gen(function* () {
  const q = yield* Queue.sliding<string>(2);
  yield* Queue.offer(q, "x");
  yield* Queue.offer(q, "y");
  yield* Queue.offer(q, "z");
  const head = yield* Queue.take(q);
  const tail = yield* Queue.take(q);
  return `${head}${tail}`;
});
console.log(Effect.runSync(sliding));

const hub = Effect.gen(function* () {
  const bus = yield* PubSub.unbounded<string>();
  const alice = yield* PubSub.subscribe(bus);
  const bob = yield* PubSub.subscribe(bus);
  yield* PubSub.publish(bus, "hello");
  const heard = yield* PubSub.take(alice);
  const echoed = yield* PubSub.take(bob);
  const late = yield* PubSub.subscribe(bus);
  yield* PubSub.publish(bus, "again");
  const fresh = yield* PubSub.take(late);
  return `${heard} ${echoed} ${fresh}`;
});
console.log(Effect.runSync(Effect.scoped(hub)));
