// @rust-only
// Services and layers on the native kernel: a `Context.Service` class is
// the key (yield* it to read the service), Layer.effect builds an
// implementation from other services, Layer.provide/merge compose, and
// Effect.provide / provideService install them for a program.
import { Context, Effect, Layer } from "effect";

interface GreeterShape {
  readonly greet: (name: string) => Effect.Effect<string>;
}
class Greeter extends Context.Service<Greeter, GreeterShape>()("app/Greeter") {}

interface ClockShape {
  readonly now: () => number;
}
class Clock extends Context.Service<Clock, ClockShape>()("app/Clock") {}

const clockLive = Layer.succeed(Clock, { now: () => 1700000000 });

const greeterLive = Layer.effect(
  Greeter,
  Effect.gen(function* () {
    const clock = yield* Clock;
    const stamp = clock.now();
    return { greet: (name: string) => Effect.succeed(`hello ${name} @${stamp}`) };
  }),
);

const program = Effect.gen(function* () {
  const greeter = yield* Greeter;
  const first = yield* greeter.greet("ana");
  const clock = yield* Clock;
  return `${first} / ${clock.now() + 1}`;
});

const appLayer = Layer.provideMerge(greeterLive, clockLive);
console.log(Effect.runSync(Effect.provide(program, appLayer)));

const hidden = program.pipe(Effect.provide(Layer.provide(greeterLive, clockLive)), Effect.provideService(Clock, { now: () => 7 }));
console.log(Effect.runSync(hidden));

const direct = Effect.gen(function* () {
  const clock = yield* Effect.service(Clock);
  return clock.now() * 2;
}).pipe(Effect.provideService(Clock, { now: () => 21 }));
console.log(Effect.runSync(direct));
