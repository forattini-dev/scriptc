// @no-engine
function convert(value: string | number | boolean | null | undefined): number { return Number(value); }
for (const value of ["", "  ", "-0", "0x10", "invalid", "Infinity", 7, false, true, null, undefined]) {
  const number = convert(value);
  console.log(String(number), Object.is(number, -0), Number.isNaN(number));
}
const capture = /^(a)?(.*)$/.exec("");
if (capture) console.log(Number(capture[1]), Number(capture[2]));
const argv: string[] = ["3"];
console.log(Number(argv[0]), Number(argv[1]));
let calls = 0;
function absent(): undefined { calls++; return undefined; }
function nil(): null { calls++; return null; }
function optional(present: boolean): string | undefined { calls++; return present ? "12" : undefined; }
console.log(Number(absent()), Number(nil()), Number(optional(true)), Number(optional(false)), calls);
function failure(): string | undefined { calls++; throw new Error("conversion-source"); }
try { console.log(Number(failure())); } catch (error) { console.log(String(error), calls); }
