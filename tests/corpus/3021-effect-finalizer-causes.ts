// @rust-only
import { Cause, Effect, PubSub } from "effect";

const hub = Effect.runSync(PubSub.unbounded<number>());
const closed = Effect.runSync(Effect.scoped(PubSub.subscribe(hub)));
const interrupted = Effect.asVoid(PubSub.take(closed));
const describe = (effect: Effect.Effect<unknown, unknown>): Effect.Effect<string> =>
  Effect.catchCause(Effect.as(effect, "success"), (cause) =>
    Effect.succeed(`${String(Cause.squash(cause))}:${Cause.hasDies(cause)}:${Cause.hasInterrupts(cause)}:${Cause.hasInterruptsOnly(cause)}`));

const mixed = Effect.scoped(Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Effect.die("defect"));
  yield* Effect.addFinalizer(() => interrupted);
}));
const seen: string[] = [];
const observed = mixed.pipe(
  Effect.tapCause((cause) => Effect.sync(() => { seen.push(`${Cause.hasDies(cause)}:${Cause.hasInterrupts(cause)}`); })),
  Effect.catch((_error: unknown) => Effect.succeed("wrong")),
  Effect.orDie,
);
console.log(await Effect.runPromise(describe(observed)));
console.log(seen.join(","));

console.log(await Effect.runPromise(describe(Effect.scoped(Effect.gen(function* () {
  yield* Effect.addFinalizer(() => interrupted);
  yield* Effect.addFinalizer(() => interrupted);
})))));

// A nested finalizer scope contributes all its reasons. A later outer
// finalizer still runs, and an outer ensuring failure replaces that cause.
const nested = Effect.scoped(Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Effect.sync(() => { seen.push("outer"); }));
  yield* Effect.addFinalizer(() => mixed);
}));
console.log(await Effect.runPromise(describe(nested)));
console.log(seen.join(","));
console.log(await Effect.runPromise(describe(Effect.ensuring(nested, Effect.die("outer failure")))));
