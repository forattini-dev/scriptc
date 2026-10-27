// @rust-only
// @no-engine
let value = 10;
console.log("assign", value += 2, value -= 4, value *= 3, value /= 2, value %= 5, value **= 3, value);
function scaled(value: number): number { value /= 1024; let unit = 0; unit += 1; return value + unit; }
let total = 0;
for (let index = 0; index < 6; index += 2) { total += index; }
console.log("loops", scaled(2048), total);
let zero = -0;
console.log("negative zero", 1 / (zero *= 2), 1 / (zero /= 2));
let negative = -7;
console.log("remainder", negative %= 3);
let base = -1;
console.log("power", base **= (1 / 0));
let nan = 0 / 0;
let one = 1;
let negativeZero = -0;
let negativeBase = -2;
console.log("power edges", nan **= 0, one **= (0 / 0), 1 / (negativeZero **= 3), negativeBase **= 0.5);
let text = "a";
console.log("string", text += "b", text += "c", text);
