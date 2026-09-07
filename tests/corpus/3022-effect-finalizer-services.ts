// @rust-only
import { Context, Effect } from "effect";

interface Named { readonly name: string }
class Name extends Context.Service<Name, Named>()("finalizers/Name") {}
const events: string[] = [];

const note = (label: string) => Effect.gen(function* () {
  const before = yield* Name;
  yield* Effect.sleep(1);
  const after = yield* Name;
  events.push(`${label}:${before.name}:${after.name}`);
});

const program = Effect.scoped(Effect.gen(function* () {
  yield* Effect.provideService(Effect.addFinalizer((exit) => note(`registered:${exit._tag}`)), Name, { name: "registered" });
  yield* Effect.provideService(Effect.acquireRelease(
    Effect.succeed(7), (resource, exit) => note(`release:${resource}:${exit._tag}`),
  ), Name, { name: "acquired" });
  yield* Effect.addFinalizer((exit) => note(`ambient:${exit._tag}`));
  yield* Effect.provideService(note("body"), Name, { name: "body" });
}));
await Effect.runPromise(Effect.provideService(program, Name, { name: "outer" }));
console.log(events.join(","));

// The service may exist only while registering the finalizer.
await Effect.runPromise(Effect.scoped(
  Effect.provideService(Effect.addFinalizer((exit) => note(`local:${exit._tag}`)), Name, { name: "local" }),
));
console.log(events.join(","));

// A failed finalizer restores the closing context before the next cleanup.
const failed = Effect.scoped(Effect.gen(function* () {
  yield* Effect.addFinalizer((exit) => note(`after-defect:${exit._tag}`));
  yield* Effect.provideService(Effect.addFinalizer(() => Effect.gen(function* () {
    yield* note("failing");
    yield* Effect.die("cleanup");
  })), Name, { name: "failing" });
}));
await Effect.runPromise(Effect.exit(Effect.provideService(failed, Name, { name: "restored" })));
console.log(events.join(","));
