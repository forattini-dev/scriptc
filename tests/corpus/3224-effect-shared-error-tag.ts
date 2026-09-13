// @rust-only
// @no-engine
import { Effect, Schema } from 'effect';
class First extends Schema.TaggedErrorClass<First>()('Missing', { first: Schema.String }) {}
class Second extends Schema.TaggedErrorClass<Second>()('Missing', { second: Schema.Number }) {}
class Other extends Schema.TaggedErrorClass<Other>()('Other', {}) {}
function failure(which: number): Effect.Effect<never, First | Second | Other> {
  if (which === 0) return Effect.fail(new First({ first: 'one' }));
  if (which === 1) return Effect.fail(new Second({ second: 2 }));
  return Effect.fail(new Other({}));
}
function recover(which: number) {
  return failure(which).pipe(
    Effect.catchTag('Missing', error => Effect.succeed(error instanceof First ? error.first : String(error.second))),
    Effect.catch(() => Effect.succeed('other')),
  );
}
console.log(await Effect.runPromise(recover(0)), await Effect.runPromise(recover(1)), await Effect.runPromise(recover(2)));
console.log(await Effect.runPromise(failure(1).pipe(Effect.catchTag('Missing', () => Effect.succeed('ignored')), Effect.catch(() => Effect.succeed('other')))));
