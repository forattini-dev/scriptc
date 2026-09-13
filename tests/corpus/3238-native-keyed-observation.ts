// @rust-only
// @no-engine
import { Effect } from 'effect';

// FSUtil also has a non-Effect-returning method. The runtime guard must
// inspect the selected property, not assume every member has one ABI.
interface Selected {
  readonly isDir: (path: string) => Effect.Effect<boolean>;
  readonly resolve: (path: string) => Effect.Effect<string>;
  readonly globMatch: (pattern: string, filepath: string) => boolean;
}
const service: Selected = {
  isDir: (path) => Effect.succeed(path === '/dir'),
  resolve: (path) => Effect.succeed('/resolved/' + path),
  globMatch: (pattern, path) => pattern === path,
};
function read<Shape>(value: Shape, key: string): unknown { return value[key as keyof Shape]; }
const dir = read(service, 'isDir');
console.log('identity', dir === read(service, 'isDir'), dir === read(service, 'resolve'));
console.log('missing', typeof read(service, 'missing'));
const scalar: unknown = { count: 7, run: () => Effect.succeed(1) };
console.log('scalar', typeof (scalar as { count: unknown }).count);
const method = read(service, 'resolve');
if (typeof method === 'function') {
  const effect = (method as (...args: unknown[]) => Effect.Effect<unknown>)('file');
  console.log('resolve', Effect.runSync(effect));
}
const match = read(service, 'globMatch');
if (typeof match === 'function') console.log('globMatch', (match as (...args: unknown[]) => boolean)('a', 'a'));
