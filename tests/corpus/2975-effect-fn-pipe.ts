// @rust-only
// Effect.fn makes a function whose calls answer the generator body as an
// effect; .pipe() and effect's pipe fold data-last combinators; the
// value members (Effect.void) and the small shapers (as/asVoid/ignore/
// andThen) round out the everyday surface. Static build, no engine.
import { Effect, pipe } from "effect";

const scale = Effect.fn("scale")(function* (n: number, by: number) {
  const base = yield* Effect.succeed(n);
  return base * by;
});

const describe = Effect.fnUntraced(function* (label: string) {
  const scaled = yield* scale(7, 6);
  return `${label}=${scaled}`;
});

const piped = describe("answer").pipe(
  Effect.map((s) => s.toUpperCase()),
  Effect.andThen((s) => Effect.succeed(`${s}!`)),
  Effect.as("replaced"),
);
console.log(Effect.runSync(piped));

const chained = pipe(
  Effect.fail("nope"),
  Effect.mapError((e) => `${e}?`),
  Effect.catch((e) => Effect.succeed(e.length)),
  Effect.andThen(Effect.succeed("after")),
);
console.log(Effect.runSync(chained));

const quiet = Effect.gen(function* () {
  yield* Effect.void;
  yield* Effect.ignore(Effect.fail("swallowed"));
  yield* Effect.asVoid(Effect.succeed(1));
  const again = yield* Effect.andThen(Effect.succeed(2), () => Effect.succeed(3));
  return again;
});
console.log(Effect.runSync(quiet));
