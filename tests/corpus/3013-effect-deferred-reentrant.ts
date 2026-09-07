// @rust-only
import { Deferred, Effect } from "effect";

const gate = Effect.runSync(Deferred.make<number>());
const waiting = Effect.runPromise(Effect.gen(function* () {
  const value = yield* Deferred.await(gate);
  const done = yield* Deferred.isDone(gate);
  const same = yield* Deferred.await(gate);
  const repeated = yield* Deferred.succeed(gate, 9);
  return `${value}:${done}:${same}:${repeated}`;
}));
console.log(await Effect.runPromise(Deferred.succeed(gate, 7)));
console.log(await waiting);
