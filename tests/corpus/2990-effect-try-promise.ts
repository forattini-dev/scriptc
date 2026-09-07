// @rust-only
// `Effect.tryPromise(() => promise)` (a rejection becomes UnknownException) and `Effect.isEffect` over a union.
import { Effect } from "effect";

const ok = Effect.tryPromise(() => Promise.resolve(41));
const bad = Effect.tryPromise(() => Promise.reject(new Error("nope")));

const program = Effect.gen(function* () {
  const value = yield* ok;
  const recovered = yield* bad.pipe(Effect.catch((e) => Effect.succeed(`${e._tag}: ${e.message}`)));
  return `${value + 1} ${recovered}`;
});

const decide = (input: number | Effect.Effect<number>): Effect.Effect<number> =>
  Effect.isEffect(input) ? input : Effect.succeed(input * 2);

Effect.runPromise(program).then((line) => {
  console.log(line);
  console.log(Effect.runSync(decide(21)), Effect.runSync(decide(Effect.succeed(7))));
});
