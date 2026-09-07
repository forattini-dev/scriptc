// @rust-only
import { Cause, Effect, PubSub } from "effect";

const events: string[] = [];
const describe = (effect: Effect.Effect<unknown, unknown>): Effect.Effect<string> =>
  Effect.catchCause(Effect.as(effect, "success"), (cause) =>
    Effect.succeed(`${String(Cause.squash(cause))}:${Cause.hasDies(cause)}:${Cause.hasInterrupts(cause)}:${Cause.hasInterruptsOnly(cause)}`));

const hub = Effect.runSync(PubSub.unbounded<number>());
const sub = Effect.runSync(Effect.scoped(Effect.gen(function* () {
  return yield* PubSub.subscribe(hub);
})));
// PubSub.take on this closed subscription supplies an interruption finalizer.
const program = Effect.scoped(Effect.gen(function* () {
  yield* PubSub.subscribe(hub);
  yield* Effect.addFinalizer((exit) => Effect.sync(() => { events.push(`first:${exit._tag}`); }));
  yield* Effect.addFinalizer(() => Effect.asVoid(PubSub.take(sub)));
  yield* Effect.addFinalizer((exit) => Effect.gen(function* () {
    yield* Effect.sleep(1);
    events.push(`middle:${exit._tag}`);
    yield* Effect.die("middle");
  }));
  yield* Effect.addFinalizer((exit) => Effect.sync(() => {
    events.push(`last:${exit._tag}`);
    throw "last";
  }));
  return yield* Effect.fail("body");
}));
console.log(await Effect.runPromise(describe(program)));
console.log(events.join(","));

// Effect 4 finalizer failure replaces the body failure for ensuring and use/release.
console.log(Effect.runSync(describe(Effect.ensuring(Effect.fail("body"), Effect.die("ensuring")))));
console.log(Effect.runSync(describe(Effect.acquireUseRelease(
  Effect.succeed(1), (n) => Effect.fail(`use:${n}`), (n, exit) => Effect.die(`release:${n}:${exit._tag}`),
))));
