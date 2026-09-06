// @rust-only
// Effect.fn with pipeline steps after the generator (`orDie`, `withSpan`,
// `catchTag`, `map`) and an opaque Duration handle flowing through a record.
import { Duration, Effect, Schema } from "effect";

class NotReady extends Schema.TaggedErrorClass<NotReady>()("NotReady", { message: Schema.String, retryIn: Schema.Number }) {}

const settings: { readonly pause: Duration.Duration; readonly label: string } = { pause: Duration.millis(5), label: "job" };

const step = Effect.fn("step")(
  function* (n: number) {
    yield* Effect.sleep(settings.pause);
    if (n < 0) return yield* new NotReady({ message: `negative ${n}`, retryIn: -n });
    return n * 2;
  },
  Effect.withSpan("step.span"),
  Effect.catchTag("NotReady", (e) => Effect.succeed(e.retryIn)),
  Effect.map((v) => `${settings.label}:${v}`),
);

const strict = Effect.fn("strict")(function* (n: number) {
  if (n === 0) return yield* Effect.fail("zero");
  return n;
}, Effect.orDie);

const program = Effect.gen(function* () {
  const a = yield* step(4);
  const b = yield* step(-3);
  const c = yield* strict(7);
  return [a, b, c];
});
Effect.runPromise(program).then((values) => console.log(values, Duration.toMillis(settings.pause)));
Effect.runPromise(step(1)).then((v) => console.log("later", v));
