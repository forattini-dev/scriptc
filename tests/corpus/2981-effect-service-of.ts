// @rust-only
// Service.of over a service key (effect's identity over the shape),
// Layer.effectDiscard (a layer that runs an effect and provides nothing),
// and a schema error caught through a union failure channel.
import { Context, Effect, Layer, Schema } from "effect";

interface CounterShape {
  readonly next: () => Effect.Effect<number>;
  readonly label: string;
}
class Counter extends Context.Service<Counter, CounterShape>()("app/Counter") {}

class Boom extends Schema.TaggedErrorClass<Boom>()("Boom", { message: Schema.String }) {}

const impl = (() => {
  let n = 0;
  return Counter.of({
    next: () => Effect.sync(() => ++n),
    label: "counter",
  });
})();

const events: string[] = [];
const audit = Layer.effectDiscard(Effect.sync(() => { events.push("audit ran"); }));
const live = Layer.succeed(Counter, impl);

const program = Effect.gen(function* () {
  const counter = yield* Counter;
  const a = yield* counter.next();
  const b = yield* counter.next();
  if (b > 10) yield* new Boom({ message: "too many" });
  return `${counter.label}: ${a} ${b}`;
});

console.log(Effect.runSync(program.pipe(Effect.provide(Layer.merge(live, audit)))));
console.log(events);
console.log(Effect.runSync(program.pipe(Effect.provide(live), Effect.catchTag("Boom", (e) => Effect.succeed(e.message)))));
