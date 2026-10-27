// @rust-only
// @no-engine
// @ts-nocheck
export {};
const names: readonly string[] = ["dark", "light"];
console.log("readonly", names.includes("dark"), names.includes("other"));
const numbers = [1, 2, Number("bad"), -0, 4];
console.log("same-value-zero", numbers.includes(Number("bad")), numbers.includes(0), numbers.includes(-0));
console.log("offset", numbers.includes(1, -5), numbers.includes(1, -4), numbers.includes(2, 1.9), numbers.includes(2, 2));
console.log("infinity", numbers.includes(1, 1 / 0), numbers.includes(1, -1 / 0), numbers.includes(1, Number("bad")));
const object = {value: 1};
const objects = [object];
console.log("identity", objects.includes(object), objects.includes({value: 1}));
let order = "";
const live = [1];
function source(): number[] { order += "s"; return live; }
function needle(): number { order += "n"; live.push(2); return 2; }
function offset(): number { order += "o"; return 0; }
console.log("effects", source().includes(needle(), offset()), order);
const empty: number[] = [];
console.log("empty", empty.includes(1, 1 / 0));
const optional: (number | undefined)[] = [undefined, 2];
console.log("undefined", optional.includes(), optional.includes(undefined), numbers.includes(undefined));
console.log("empty-bigint", empty.includes(1, 1n));
try { numbers.includes(1, 1n); }
catch (error) { console.log("bigint-offset", error instanceof TypeError); }
