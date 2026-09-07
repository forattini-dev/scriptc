// @rust-only
import { Cause, Effect } from "effect";

const read = (effect: Effect.Effect<unknown>): string =>
  String(Effect.runSync(effect));
const failure = (effect: Effect.Effect<never, unknown>): string =>
  Effect.runSync(Effect.catchCause(effect, (cause) =>
    Effect.succeed(String(Cause.squash(cause)))));

console.log(read(Effect.succeed("text")));
console.log(read(Effect.succeed(42)));
console.log(read(Effect.succeed(false)));
console.log(read(Effect.succeed(null)));
console.log(read(Effect.succeed(undefined)));
console.log(failure(Effect.fail("failure")));
console.log(failure(Effect.fail(7)));
console.log(failure(Effect.fail(true)));
console.log(failure(Effect.fail(null)));
console.log(failure(Effect.fail(undefined)));

// A dynamic Error crossing the channel twice must retain its identity.
const error: unknown = new Error("same");
console.log(Effect.runSync(Effect.succeed(error)) === error);
console.log(Effect.runSync(Effect.succeed(null)) === null);
