// @no-engine
function report(value: any): void {
  console.log(Number(value), Number.parseInt(value, 10), parseInt(value, 10), Number.parseFloat(value), parseFloat(value));
}
for (const value of [undefined, null, true, false, 0, -0, NaN, Infinity, -Infinity, '', ' 42 ', '0x10', '0b11', '1e2', '3.5tail', [], [12], [1, 2], {}]) report(value);
function negativeZero(value: unknown): boolean { return Object.is(Number(value), -0); }
console.log(negativeZero(-0));
function radix(value: any): void { console.log(Number.parseInt('11', value), parseInt('11', value)); }
for (const value of [undefined, null, true, false, '2', 16, 2.9, 4294967298, NaN, Infinity]) radix(value);
const missing: string[] = [];
console.log(Number(missing[0]));
radix(missing[0]);
