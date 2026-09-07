// @rust-only
// `Effect.catchCause` over the failure channel, with Cause.squash and the die/interrupt questions.
import { Cause, Effect, Schema } from "effect";

class Broken extends Schema.TaggedErrorClass<Broken>()("Broken", { why: Schema.String }) {}

// A CLASS failure reaches the handler with its own type through catchCause's Cause.
const classFailure = Effect.fail(new Broken({ why: "disk" })).pipe(
  Effect.catchCause((cause) => Effect.succeed(`dies=${Cause.hasDies(cause)} interrupts=${Cause.hasInterrupts(cause)}`)),
);
console.log(Effect.runSync(classFailure));

// A STRING failure channel squashes into the site's checked-dynamic slot.
const textFailure = Effect.fail("disk").pipe(
  Effect.catchCause((cause) => Effect.succeed(`${String(Cause.squash(cause))}!`)),
);
console.log(Effect.runSync(textFailure));

const built = Cause.fail("built");
console.log(String(Cause.squash(built)), Cause.hasInterruptsOnly(built), Cause.hasDies(built));
