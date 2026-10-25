// @rust-only
// @no-engine
// @ts-nocheck
const numbers: number[] = [1, 2];
const alias = numbers;
console.log('number', numbers.pop(), alias.length, alias.pop(), numbers.pop() === undefined, numbers.length);
const words: string[] = ['a'];
console.log('string', words.pop(), words.pop() === undefined);
const optional: (string | undefined)[] = ['v', undefined];
console.log('optional', optional.pop() === undefined, optional.pop(), optional.pop() === undefined);
const frame = { key: 'frame' };
const frames = [frame];
const popped = frames.pop();
console.log('record', popped === frame, frames.length, frames.pop() === undefined);
let active: number[] = [3];
const original = active;
let trace = '';
function receiver(): number[] { trace = trace + 'R'; return active; }
function ignored(): number { trace = trace + 'A'; active = [8]; original.push(4); return 9; }
console.log('effects', receiver().pop(ignored()), trace, original.length, active.length);
function fail(): number { trace = trace + 'X'; throw new Error('extra'); }
try { original.pop(fail()); } catch (error) { if (error instanceof Error) console.log('abrupt', error.message, original.length, trace); else throw error; }
