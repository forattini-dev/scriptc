// @rust-only
// @no-engine
import { Effect } from 'effect';

function erase<T>(program: Effect.Effect<T>): Effect.Effect<unknown> { return program; }
const strings = ['first', 'second'];
const pending = erase(Effect.sync(() => strings));
const opaque = Effect.runSync(pending);
const restored = opaque as string[];
console.log('strings', restored === strings, restored[0]);
strings[0] = 'changed';
restored.push('third');
console.log('live', (opaque as string[])[0], strings.length, Effect.runSync(pending) === opaque);

const numbers = [1, 2];
const n = Effect.runSync(erase(Effect.succeed(numbers))) as number[];
n[1] = 7;
console.log('numbers', n === numbers, numbers[1]);
const flags = [true, false];
const b = Effect.runSync(erase(Effect.succeed(flags))) as boolean[];
b[0] = false;
console.log('flags', b === flags, flags[0]);
const date = new Date(1700000000000);
const dates = [date];
const d = Effect.runSync(erase(Effect.succeed(dates))) as Date[];
console.log('dates', d === dates, d[0] === date);
const effects = [Effect.succeed('ok')];
const e = Effect.runSync(erase(Effect.succeed(effects))) as Effect.Effect<string>[];
console.log('effects', e === effects, e[0] === effects[0], Effect.runSync(e[0]));
const values: unknown[] = ['value', 3, true];
const v = Effect.runSync(erase(Effect.succeed(values))) as unknown[];
console.log('unknown', v === values, v[1]);
const bytes = new Uint8Array([5]);
const u = Effect.runSync(erase(Effect.succeed(bytes))) as Uint8Array;
u[0] = 9;
console.log('bytes', u === bytes, bytes[0]);

const byteUnion: unknown = bytes;
const bytesOrText = byteUnion as Uint8Array | string | undefined;
console.log('byte union', typeof bytesOrText === 'object' && bytesOrText === bytes);
const textUnion: unknown = 'text';
const textOrBytes = textUnion as Uint8Array | string;
console.log('text union', typeof textOrBytes === 'string' ? textOrBytes : textOrBytes[0]);
