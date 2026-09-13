// @rust-only
// @no-engine
import { Effect } from 'effect';

const format = Effect.fn('format')(function* (path: string, mode?: number) {
  yield* Effect.succeed(undefined);
  return `${path}:${mode === undefined ? 'missing' : String(mode)}`;
});
console.log(await Effect.runPromise(format('a')));
console.log(await Effect.runPromise(format('b', undefined)));
console.log(await Effect.runPromise(format('c', 0)));
console.log(await Effect.runPromise(format('d', 7)));

const defaulted = Effect.fn('defaulted')(function* (value: number = 9) {
  yield* Effect.succeed(undefined);
  return value;
});
console.log(await Effect.runPromise(defaulted()), await Effect.runPromise(defaulted(undefined)), await Effect.runPromise(defaulted(0)));

interface Options { prefix: string }
const configured = Effect.fn('configured')(function* (path: string, options?: Options) {
  yield* Effect.succeed(undefined);
  return options === undefined ? path : options.prefix + path;
});
const methods = { configured };
console.log(await Effect.runPromise(methods.configured('x')));
console.log(await Effect.runPromise(methods.configured('y', { prefix: 'p:' })));

let defaults = 0;
function nextDefault(): number { defaults++; return defaults; }
const repeated = Effect.fn('repeated')(function* (value: number = nextDefault()) {
  yield* Effect.succeed(undefined);
  return value;
});
const program = repeated();
console.log('created', defaults);
console.log(await Effect.runPromise(program), defaults);
console.log(await Effect.runPromise(program), defaults);
console.log(await Effect.runPromise(repeated(0)), defaults);
