// @rust-only
// Effect context primitives the SQL client layer uses: Context.Reference defaults, Effect.withFiber +
// Context.get over the fiber context, Effect.serviceOption, and uninterruptibleMask with Fiber.getCurrent,
// Context.getUnsafe(…, Scope.Scope), Scope.addFinalizer and semaphore take/release.
import { Context, Effect, Fiber, Option, Scope, Semaphore } from "effect";

const SafeIntegers = Context.Reference<boolean>("probe/SafeIntegers", { defaultValue: () => false });
class Tx extends Context.Service<Tx, { readonly id: number }>()("probe/Tx") {}

const readFlag = Effect.withFiber((fiber) => Effect.succeed(Context.get(fiber.context, SafeIntegers)));

const program = Effect.gen(function* () {
  console.log("default", yield* readFlag);
  console.log("provided", yield* readFlag.pipe(Effect.provideService(SafeIntegers, true)));
  const none = yield* Effect.serviceOption(Tx);
  console.log("serviceOption none", Option.isNone(none));
  const some = yield* Effect.serviceOption(Tx).pipe(Effect.provideService(Tx, { id: 7 }));
  console.log("serviceOption some", Option.isSome(some) ? some.value.id : -1);
  const semaphore = yield* Semaphore.make(1);
  yield* Effect.scoped(
    Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!;
      const scope = Context.getUnsafe(fiber.context, Scope.Scope);
      return Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, Effect.sync(() => console.log("released")).pipe(Effect.andThen(semaphore.release(1)))));
    }),
  );
  console.log("after scope");
  yield* semaphore.withPermits(1)(Effect.sync(() => console.log("permit available again")));
});

Effect.runPromise(program).then(() => console.log("done"));
