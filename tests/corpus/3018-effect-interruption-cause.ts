// @rust-only
import { Cause, Effect, Queue } from "effect";

const queue = Effect.runSync(Queue.unbounded<number>());
Effect.runSync(Queue.shutdown(queue));
// A never error channel can still carry interruption; squash returns an Error.
console.log(await Effect.runPromise(Effect.catchCause(Queue.take(queue), (cause) =>
  Effect.succeed(String(Cause.squash(cause))))));
// Defects also need not have the type of the typed error channel.
const typed: Effect.Effect<number, number> = Effect.die("defect");
console.log(Effect.runSync(Effect.catchCause(typed, (cause) => Effect.succeed(String(Cause.squash(cause))))));
console.log(Effect.runSync(Effect.catchCause(Effect.fail(42), (cause) => Effect.succeed(String(Cause.squash(cause))))));
