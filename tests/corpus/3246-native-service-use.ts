// @rust-only
// @no-engine
import { Context, Effect } from 'effect';

type EffectMethod = (...args: ReadonlyArray<never>) => Effect.Effect<unknown, unknown, unknown>;
type ServiceUse<Identifier, Shape> = {
  readonly [Key in keyof Shape as Shape[Key] extends EffectMethod ? Key : never]: Shape[Key] extends (...args: infer Args) => infer Return
    ? Args extends ReadonlyArray<unknown>
      ? Return extends Effect.Effect<infer A, infer E, infer R> ? (...args: Args) => Effect.Effect<A, E, R | Identifier> : never
      : never
    : never;
};
// Same generic implementation as the original Redcode service-use module.
// A separate consumer acceptance probe imports that original file directly.
const serviceUse = <Identifier, Shape>(tag: Context.Service<Identifier, Shape>) => {
  const cache = new Map<string, (...args: unknown[]) => Effect.Effect<unknown, unknown, unknown>>();
  const access = new Proxy({}, {
    get: (_, key) => {
      if (typeof key !== 'string') return undefined;
      const cached = cache.get(key);
      if (cached) return cached;
      const accessor = (...args: unknown[]) => tag.use((service) => {
        const method = service[key as keyof Shape];
        if (typeof method !== 'function') return Effect.die(new Error(`Service method not found: ${key}`));
        return (method as (...args: unknown[]) => Effect.Effect<unknown, unknown, unknown>)(...args);
      });
      cache.set(key, accessor);
      return accessor;
    },
  });
  return access as ServiceUse<Identifier, Shape>;
};
type Shape = {
  read: (path: string, mode?: number) => Effect.Effect<string>;
  bytes: (value: Uint8Array) => Effect.Effect<Uint8Array>;
  list: (options: { paths: string[] }) => Effect.Effect<string[]>;
};
class Service extends Context.Service<Service, Shape>()('native-proxy-service') {}
let runs = 0;
const service: Shape = {
  read: (path, mode) => Effect.sync(() => { runs++; return path + ':' + (mode ?? 0); }),
  bytes: value => Effect.sync(() => { runs++; return value; }),
  list: options => Effect.sync(() => { runs++; return options.paths; }),
};
const use = serviceUse(Service);
const read = use.read;
console.log('created', runs, read === use.read, (use as any)[Symbol('probe')] === undefined);
const lazy = Effect.provideService(read('/a', 3), Service, service);
console.log('before', runs);
console.log('first', Effect.runSync(lazy), runs);
console.log('second', Effect.runSync(lazy), runs);
service.read = (path, mode) => Effect.sync(() => { runs++; return 'new:' + path; });
console.log('replacement', Effect.runSync(lazy), runs, use.read === read);
const bytes = new Uint8Array([4]);
const byteEffect = Effect.provideService(use.bytes(bytes), Service, service);
bytes[0] = 9;
const result = Effect.runSync(byteEffect);
console.log('bytes', result === bytes, result[0]);
const options = { paths: ['a', 'b'] };
const paths = Effect.runSync(Effect.provideService(use.list(options), Service, service));
console.log('list', paths === options.paths, paths.join(','));
const opaque: unknown = use;
const missing = (opaque as { absent: () => Effect.Effect<unknown> }).absent;
console.log('missing-lazy', typeof missing, runs);
try { Effect.runSync(Effect.provideService(missing(), Service, service)); }
catch { console.log('missing-failed', runs); }
