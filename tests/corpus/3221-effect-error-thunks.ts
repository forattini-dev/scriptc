// @rust-only
// @no-engine
import { Effect, Schema } from 'effect';
class Missing extends Schema.TaggedErrorClass<Missing>()('Missing', { key: Schema.String }) {}
class Busy extends Schema.TaggedErrorClass<Busy>()('Busy', {}) {}
let handled = 0;
const recover = () => { handled++; return Effect.succeed('recovered'); };
console.log(await Effect.runPromise(Effect.fail('bad').pipe(Effect.catch(recover))), handled);
console.log(await Effect.runPromise(Effect.succeed('ok').pipe(Effect.catch(recover))), handled);
console.log(await Effect.runPromise(Effect.fail('bad').pipe(Effect.mapError(() => 'mapped'), Effect.catch((error) => Effect.succeed(error)))));
function source(missing: boolean): Effect.Effect<never, Missing | Busy> {
  return missing ? Effect.fail(new Missing({ key: 'x' })) : Effect.fail(new Busy({}));
}
console.log(await Effect.runPromise(source(true).pipe(Effect.catchTag('Missing', recover), Effect.catch(() => Effect.succeed('other')))), handled);
console.log(await Effect.runPromise(source(false).pipe(Effect.catchTag('Missing', recover), Effect.catch(() => Effect.succeed('other')))), handled);
