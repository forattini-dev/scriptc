// @rust-only
// @no-engine

const values = new Array<unknown>(3);
values[1] = "x";
values[2] = null;
console.log("values", values.length, 0 in values, 1 in values, values.join("|"));
const input: unknown = JSON.parse("2");
const count = new Array<unknown>(input);
console.log("count", count.length, count[0] === undefined);
const stringInput: unknown = JSON.parse('"2"');
console.log("item", Array<unknown>(stringInput).join("|"));
console.log("mixed", new Array<unknown>(1, "x", false, null, undefined).join("|"));
