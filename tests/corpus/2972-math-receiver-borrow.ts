const bytes = Buffer.alloc(6);
let index = 0;
bytes[Math.floor(index++)] = Math.min(255, Math.max(0, Math.floor(258.9)));
bytes[Math.ceil(index++)] = Math.round(12.5);
bytes[Math.trunc(index++)] = Math.abs(-258.9);
bytes[index++] = Math.pow(2, 8) + 1;
bytes[index++] = Math.sqrt(81);
bytes[index++] = Math.floor(bytes[Math.floor(0)] / 2);
console.log("buffer", bytes.toString("hex"), index);

const values = new Float64Array(7);
values[0] = Math.floor(-0);
values[1] = Math.round(-0.25);
values[2] = Math.min(0, -0);
values[3] = Math.max(-0, 0);
values[4] = Math.sqrt(-1);
values[5] = Math.pow(-0, -3);
values[6] = Math.floor(Infinity);
console.log("ieee", 1 / values[0], 1 / values[1], 1 / values[2], 1 / values[3], values[4], values[5], values[6]);

const unsigned = new Uint32Array(1);
const signed = new Int32Array(1);
const narrow = new Float32Array(1);
unsigned[0] = Math.floor(4294967297);
signed[0] = Math.ceil(-2147483649);
narrow[0] = Math.sign(-0);
console.log("kinds", unsigned[0], signed[0], 1 / narrow[0]);

// Exact inputs avoid unrelated libm/V8 rounding differences.
const analytic = new Float64Array(13);
analytic[0] = Math.sin(-0);
analytic[1] = Math.cos(0);
analytic[2] = Math.tan(-0);
analytic[3] = Math.asin(-0);
analytic[4] = Math.acos(1);
analytic[5] = Math.atan(-0);
analytic[6] = Math.atan2(-0, 1);
analytic[7] = Math.cbrt(-0);
analytic[8] = Math.exp(0);
analytic[9] = Math.log(1);
analytic[10] = Math.log2(1);
analytic[11] = Math.log10(1);
analytic[12] = Math.sign(-0);
for (let i = 0; i < analytic.length; i++) console.log("analytic", i, analytic[i], 1 / analytic[i]);

function replaceInMath(): void {
  let target = new Uint8Array(1);
  const replacement = new Uint8Array([99]);
  // No alias owns the old allocation: a premature release is an ASan error.
  target[0] = Math.floor((target = replacement) ? 17.9 : 0);
  console.log("replace-value", target[0]);
  target = new Uint8Array([23]);
  console.log("replace-index", target[Math.floor((target = replacement) ? 0 : 0)], target[0]);
  target = new Uint8Array(1);
  target[0] = Math.min(40, Math.floor((target = replacement) ? 19.9 : 0));
  console.log("replace-nested", target[0]);
}
replaceInMath();

let globalTarget = Buffer.alloc(1);
function replace(): number { globalTarget = Buffer.from([88]); return 12.9; }
globalTarget[0] = Math.floor(replace());
console.log("global-call", globalTarget[0]);

function captured(): void {
  let target = new Uint8Array([5]);
  function change(): number { target = new Uint8Array([77]); return 13.8; }
  target[0] = Math.floor(change());
  target[0] = Math.floor(9.8);
  console.log("captured", target[0]);
}
captured();

let trace = "";
function fail(): number { trace += "x"; throw new Error("operand"); }
const unchanged = new Uint8Array([6]);
try { unchanged[0] = Math.floor(fail()); } catch (e) { console.log("throw", (e as Error).message, unchanged[0], trace); }
let nextIndex = 0;
unchanged[Math.floor(nextIndex++)] = Math.min(nextIndex = nextIndex + 2, nextIndex = nextIndex + 3);
console.log("order", nextIndex, unchanged[0]);

const numbers = [10, 20, 30];
console.log("array-read", numbers[Math.floor(1.9)] * 2, numbers[Math.ceil(-0.5)] + 1);
const alias = bytes;
alias[Math.floor(0)] = Math.ceil(4.1);
console.log("alias", bytes[0]);
new Uint8Array(1)[Math.floor(0)] = Math.floor(7.9);
const flag = true;
(flag ? new Uint8Array(1) : new Uint8Array(2))[0] = Math.floor(8.9);
