const exact = 1 + 2 ** -40;
const floats = new Float64Array(4);
floats.set([exact, -exact], 1);
console.log(floats[0], floats[1] === exact, floats[2] === -exact, floats[3]);
const tuple = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
const bytes = new Uint8Array(14);
bytes.set(tuple, 1);
console.log(bytes.join(","));
const source = [256, -1, 3.9];
let calls = 0;
function getSource(): number[] { calls++; return source; }
function offset(): number { source[0] = 7; return 0; }
bytes.set(getSource(), offset());
console.log(calls, bytes[0], bytes[1], bytes[2]);
const shared = new Uint8Array([1, 2, 3, 4]);
shared.set(shared.subarray(0, 3), 1);
console.log(shared.join(","));
const small = new Uint8Array([9, 9]);
try { small.set([1, 2, 3]); } catch (error) { console.log(error instanceof RangeError); }
console.log(small.join(","));
try { small.set([1], -1); } catch (error) { console.log(error instanceof RangeError); }
small.set([], 2);
console.log(small.join(","));
