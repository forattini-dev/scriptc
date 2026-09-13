// @rust-only
// Root exports and namespace subpaths must share the same native kernels.
import { Effect as RootEffect } from "effect";
import * as FX from "effect/Effect";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class Clock extends Context.Service<Clock, { readonly now: () => number }>()("subpath/Clock") {}
const live = Layer.succeed(Clock, { now: () => 21 });
const program = FX.gen(function* () {
  const clock = yield* Clock;
  return yield* RootEffect.succeed(clock.now() * 2);
});
console.log(FX.runSync(RootEffect.provide(program, live)));
console.log(Option.getOrElse(Option.some(7), () => 0));
console.log(Option.getOrElse(Option.none<number>(), () => 9));
console.log(Schema.decodeUnknownSync(Schema.Number)(3));
