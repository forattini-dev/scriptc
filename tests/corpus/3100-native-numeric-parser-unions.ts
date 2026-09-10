// @no-engine
const match = /^(x)?(.*)$/.exec("123.5tail")!;
for (const radix of [0, 10, 32, 36]) {
  console.log(Number.parseInt(match[1], radix), Number.parseInt(match[2], radix));
}
console.log(Number.parseFloat(match[1]), Number.parseFloat(match[2]));
const values: string[] = ["0x20", "-0", "3.5suffix"];
console.log(Number.parseInt(values[0]), Number.parseInt(values[3]));
console.log(parseFloat(values[2]), parseFloat(values[3]));
let order = "";
function capture(): RegExpExecArray { order += "capture;"; return /^(x)?$/.exec("")!; }
function radix(): number { order += "radix;"; return 36; }
console.log(Number.parseInt(capture()[1], radix()), order);
order = "";
function failure(): RegExpExecArray { order += "failure;"; throw new Error("source"); }
try { console.log(Number.parseInt(failure()[1], radix())); }
catch (error) { console.log(String(error), order); }
