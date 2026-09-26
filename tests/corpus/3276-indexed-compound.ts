// Indexed compounds use one receiver and index evaluation, read before the
// RHS, and yield the pre-storage value for typed arrays and Buffers.
const numbers = [10, 13, 6, 24, 17, 3, 14, 8, 12, 3, -16, -1];
numbers[0] += 5;
numbers[1] -= 4;
numbers[2] *= 3;
numbers[3] /= 4;
numbers[4] %= 6;
numbers[5] **= 3;
numbers[6] &= 11;
numbers[7] |= 3;
numbers[8] ^= 5;
numbers[9] <<= 2;
numbers[10] >>= 2;
numbers[11] >>>= 1;
console.log("operators", numbers.join(","));

const words = ["first", "second"];
const joined = words[0] += "!";
console.log("strings", joined, words[0]);
const missingWord = words[3] += "?";
console.log("missing-string", missingWord, words.length);

const holes: number[] = [4];
const missing = holes[2] += 5;
console.log("missing", Number.isNaN(missing), Number.isNaN(holes[2]), holes.length, 1 in holes);

let trace = "";
const original = [8];
const other = [100];
let current = original;
let nextIndex = 0;
function receiver(): number[] { trace += "R"; return current; }
function index(): number { trace += "I"; return nextIndex++; }
function rhs(): number { trace += "V"; original[0] = 50; current = other; return 3; }
const changed = receiver()[index()] += rhs();
console.log("order", trace, changed, original[0], other[0], nextIndex);

const grid = [[4]];
const nested = grid[0][0] += 2;
console.log("nested", nested, grid[0][0]);

const bytes = new Uint8Array([255, 10]);
const byteResult = bytes[0] += 2;
bytes[1] <<= 2;
console.log("uint8", byteResult, bytes[0], bytes[1]);

const unsigned = new Uint32Array(1);
unsigned[0] = 4294967295;
const unsignedResult = unsigned[0] += 2;
console.log("uint32", unsignedResult, unsigned[0]);

const signed = new Int32Array(1);
signed[0] = -4;
signed[0] >>= 1;
console.log("int32", signed[0]);

const singles = new Float32Array(1);
singles[0] = 0.5;
singles[0] *= 1.5;
console.log("float32", singles[0]);

const floats = new Float64Array(1);
floats[0] = 0.5;
floats[0] *= 1.5;
console.log("float64", floats[0]);

const buffer = Buffer.from([254, 3]);
const bufferResult = buffer[0] += 5;
buffer[1] ^= 6;
console.log("buffer", bufferResult, buffer[0], buffer[1]);
