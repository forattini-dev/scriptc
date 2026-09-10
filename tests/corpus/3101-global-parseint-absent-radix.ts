// @no-engine
const values: string[] = ["123"];
for (const radix of [0, 10, 32, 36]) console.log(parseInt(values[1], radix));
let order = "";
function source(): string[] { order += "source;"; return []; }
function radix(): number { order += "radix;"; return 36; }
console.log(parseInt(source()[0], radix()), order);
