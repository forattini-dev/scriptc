// @ts-nocheck
// @rust-only
// @no-engine
export {};
const integer = Number.parseInt;
const floating = parseFloat;
const alias = integer;
console.log("identity", integer === parseInt, floating === Number.parseFloat, alias === integer, integer !== floating);
console.log("receiver", integer.call(null, "ff", 16), integer.apply(undefined, ["101", 2]));
const bound = integer.bind(null, "ff");
console.log("bound", bound(16), bound(10), bound !== integer);
const boundFloat = floating.bind(undefined, "2.5tail", Symbol("ignored"));
console.log("bound float", boundFloat());
const holder = { integer, floating };
console.log("record", holder.integer("42tail"), holder.floating("2.5tail"));
const inputs = ["10", "10", "10"];
console.log("callback", inputs.map(integer).join(","), inputs.map(floating).join(","));
const custom = { parseInt(value: string): number { return value.length; } };
function shadow(Number: {parseInt(value: string): number}): number { return Number.parseInt("local"); }
console.log("shadow member", shadow(custom));
function local(parseInt: (text: string) => number): number { return parseInt("custom"); }
console.log("shadow global", local(custom.parseInt));
