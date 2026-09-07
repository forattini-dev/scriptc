// @rust-only
// Bare pipe steps (`Effect.scoped`, `Effect.exit`, `Effect.uninterruptible`), `Effect.delay` and `Effect.tapCause`.
import { Cause, Effect, Exit } from "effect";

const scoped = Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Effect.sync(() => console.log("closed")));
  return "body";
}).pipe(Effect.scoped, Effect.uninterruptible);
console.log(Effect.runSync(scoped));

const exited = Effect.fail("boom").pipe(Effect.exit);
const exit = Effect.runSync(exited);
console.log(Exit.isFailure(exit), exit._tag);

const delayed = Effect.succeed(7).pipe(Effect.delay("5 millis"));
Effect.runPromise(delayed).then((value) => console.log("after", value));

const observed = Effect.fail("why").pipe(
  Effect.tapCause((cause) => Effect.sync(() => console.log("saw", String(Cause.squash(cause))))),
  Effect.catch((e) => Effect.succeed(`recovered ${e}`)),
);
console.log(Effect.runSync(observed));
