// @rust-only
// @no-engine
import { Effect } from 'effect';
type Failure = { _tag: 'Missing'; detail: string } | { _tag: 'Busy'; detail: string };
function source(missing: boolean): Effect.Effect<never, Failure> {
  return Effect.fail(missing ? { _tag: 'Missing', detail: 'm' } : { _tag: 'Busy', detail: 'b' });
}
function recover(missing: boolean) {
  return source(missing).pipe(
    Effect.catchTag('Missing', (error) => Effect.succeed(`missing:${error.detail}`)),
    Effect.catch((error) => Effect.succeed(`other:${error.detail}`)),
  );
}
console.log(await Effect.runPromise(recover(true)));
console.log(await Effect.runPromise(recover(false)));

let order = '';
function orderedSource(): Effect.Effect<never, Failure> {
  order += 'source;';
  return source(true);
}
function makeHandler() {
  order += 'handler;';
  return (error: { _tag: 'Missing'; detail: string }) => Effect.succeed(error.detail);
}
const ordered = Effect.catchTag(orderedSource(), 'Missing', makeHandler());
console.log(order, await Effect.runPromise(ordered.pipe(Effect.catch((error) => Effect.succeed(error.detail)))));
