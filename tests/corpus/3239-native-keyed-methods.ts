// @rust-only
// @no-engine
import { Effect } from 'effect';
import type { FileSystem } from 'effect';

// These are the original Redcode FSUtil signatures, including inherited
// FileSystem methods, their error channels, and SizeInput's BigInt branding.
type Selected = Pick<FileSystem.FileSystem, 'access' | 'copy' | 'truncate' | 'utimes' | 'writeFile'> & {
  readonly writeWithDirs: (path: string, content: string | Uint8Array, mode?: number) => Effect.Effect<void, unknown>;
  readonly up: (options: { targets: string[]; start: string; stop?: string }) => Effect.Effect<string[], unknown>;
};
let executions = 0;
const bytes = new Uint8Array([7, 8]);
const options: Parameters<Selected['up']>[0] = { targets: ['src', 'test'], start: '/project', stop: '/' };
const date = new Date(1700000000000);
const service: Selected = {
  access: (path, access) => Effect.sync(() => { executions++; console.log('access', path, access?.readable); }),
  copy: (from, to, copy) => Effect.sync(() => { executions++; console.log('copy', from, to, copy?.overwrite); }),
  truncate: (path, length) => Effect.sync(() => { executions++; console.log('truncate', path, length === 9007199254740993n, length === undefined); }),
  utimes: (path, atime, mtime) => Effect.sync(() => { executions++; console.log('utimes', path, atime === date, mtime === 123); }),
  writeFile: (path, data, write) => Effect.sync(() => { executions++; console.log('writeFile', path, data === bytes, data[0], write?.mode); }),
  writeWithDirs: (path, content, mode) => Effect.sync(() => { executions++; console.log('writeWithDirs', path, typeof content === 'string' ? content : content[1], mode); }),
  up: (value) => Effect.sync(() => { executions++; console.log('up', value === options, value.targets === options.targets, value.start); return value.targets; }),
};

// The exact extraction/guard/call sequence from ServiceUse, isolated from
// Proxy so the callable-keyed-read capability can be verified independently.
function invoke<Shape>(service: Shape, key: string, args: unknown[]): Effect.Effect<unknown, unknown, unknown> {
  const method = service[key as keyof Shape];
  if (typeof method !== 'function') return Effect.die(new Error(`Service method not found: ${key}`));
  return (method as (...args: unknown[]) => Effect.Effect<unknown, unknown, unknown>)(...args);
}
function run(key: string, args: unknown[]): void {
  const effect = invoke(service, key, args);
  Effect.runSync(effect as Effect.Effect<unknown>);
}
const lazy = invoke(service, 'access', ['/a', { readable: true }]);
console.log('created', executions);
Effect.runSync(lazy as Effect.Effect<unknown>);
Effect.runSync(lazy as Effect.Effect<unknown>);
run('access', ['/a']);
run('copy', ['/from', '/to', { overwrite: true }]);
run('truncate', ['/big', 9007199254740993n]);
run('truncate', ['/default']);
run('utimes', ['/time', date, 123]);
const write = invoke(service, 'writeFile', ['/bytes', bytes, { mode: 384 }]);
bytes[0] = 9;
Effect.runSync(write as Effect.Effect<unknown>);
run('writeWithDirs', ['/nested', 'text']);
run('writeWithDirs', ['/nested', bytes, 448]);
run('up', [options]);
console.log('executions', executions);
