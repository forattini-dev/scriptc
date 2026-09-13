// @rust-only
// @no-engine
import { Effect } from 'effect';

function same(left: unknown, right: unknown): boolean { return left === right; }
const bytes = new Uint8Array([5]);
function writeFile(data: Uint8Array): Effect.Effect<void> {
  return Effect.sync(() => console.log('bytes', data === bytes, data[0]));
}
const stored: unknown = writeFile;
const program = (stored as (...args: unknown[]) => Effect.Effect<void>)(bytes);
bytes[0] = 9;
Effect.runSync(program);
bytes[0] = 12;
Effect.runSync(program);

const backing = new Uint8Array([10, 20, 30, 40]);
const view = backing.subarray(1, 3);
const opaque: unknown = view;
const restored = opaque as Uint8Array;
console.log('view', restored === view, same(view, restored), restored.length, restored[0]);
restored[0] = 21;
backing[2] = 31;
console.log('mutations', backing[1], restored[1], (opaque as Uint8Array)[1]);
const refs: Record<string, unknown> = {};
refs.data = view;
console.log('record', (refs.data as Uint8Array) === view);
(refs.data as Uint8Array)[1] = 32;
console.log('record write', backing[2]);

const clone = structuredClone(opaque) as Uint8Array;
console.log('clone', clone === view, clone.length, clone[0], clone[1]);
clone[0] = 99;
console.log('clone isolated', backing[1], clone[0]);
const slice = view.slice(0);
console.log('slice', same(slice, view), slice[0], slice[1]);
slice[0] = 88;
console.log('slice isolated', view[0], slice[0]);

const buffer = Buffer.from([1, 2, 3]);
const bufferSlot: unknown = buffer;
const bufferBack = bufferSlot as Uint8Array;
console.log('buffer reference', bufferBack === buffer);
bufferBack[1] = 8;
console.log('buffer mutation', buffer[1]);
const empty = new Uint8Array(0);
const emptySlot: unknown = empty;
console.log('empty', (emptySlot as Uint8Array) === empty);
