// @ts-nocheck
// @rust-only
// @no-engine
export {};
let trace = '';
function area(width: any, height: any): any { trace += 'A'; return width * height; }
const gray = new Float32Array(area(3, 2));
gray[5] = 0.1;
console.log('dynamic', gray.length, gray.byteLength, gray[5], trace);
const boxed: any = '3';
console.log('primitives', new Float64Array(boxed).byteLength, new Float32Array(true).length, new Uint8Array(null).length, new Float32Array(undefined).length, new Float64Array('bad').length);
function touch(): void { trace += 'V'; }
console.log('void', new Float32Array(touch()).length, trace);
try { new Float32Array(area(2n, 3n)); } catch (error) { console.log('bigint', String(error.name), String(error.message), trace); }
try { new Float64Array(Symbol('length')); } catch (error) { console.log('symbol', String(error.name), String(error.message)); }
