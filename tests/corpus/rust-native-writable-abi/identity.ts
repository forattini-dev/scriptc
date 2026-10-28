import type { Writable } from 'node:stream';

const state = { token: 1 };
const stream = state as unknown as Writable;
function same(left: Writable, right: Writable): boolean { return left === right; }
function choose(value?: Writable): Writable | undefined { return value; }
const callbacks = { same, choose };
const alias = callbacks.choose(stream);
console.log('same', alias === stream, callbacks.same(stream, stream));
console.log('absent', callbacks.choose() === undefined);
state.token = 7;
console.log('live', (alias as unknown as { token: number }).token);
