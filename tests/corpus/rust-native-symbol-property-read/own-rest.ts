// @rust-only
// @no-engine
const first = Symbol('same');
const second = Symbol('same');
const source: any = { skip: 'excluded', keep: 'kept' };
source[first] = 'a';
source[second] = 'b';
const absent = Symbol('same');
const undefinedKey = Symbol('undefined');
source[undefinedKey] = undefined;
console.log('presence', first in source, absent in source, undefinedKey in source);
const { skip, ...rest } = source;
console.log('rest', skip as string, rest.keep as string, rest[first] as string, rest[second] as string, Object.keys(rest).join(','));
console.log('rest presence', first in rest, absent in rest, undefinedKey in rest);
let order = '';
function keyEffect(): symbol { order += 'key'; return first; }
function objectEffect(): any { order += ',object'; return source; }
console.log('order', keyEffect() in objectEffect(), order);
source[first] = 'changed';
console.log('copy', rest[first] as string, source[first] as string);
function project({ skip, ...tail }: any): any { return tail; }
const parameter: any = project(source);
console.log('parameter', parameter[first] as string, parameter[second] as string, parameter.keep as string);
const typed: { skip: string; keep: string } = source;
const { skip: removed, ...typedRest } = typed;
const view: any = typedRest;
console.log('typed', removed, view[first] as string, view[second] as string, typedRest.keep);
