// @rust-only
// @no-engine
// @ts-nocheck
export {};
function own(value: unknown, key: string) { return Object.hasOwn(value as object, key); }
console.log("primitive", own(1, "x"), own(false, "x"), own(1n, "x"), own(Symbol("x"), "x"));
console.log("string", own("😀", "length"), own("😀", "0"), own("😀", "1"), own("😀", "2"), own("😀", "01"));
try { own(null, "x"); } catch (error) { console.log("null", error instanceof TypeError); }
try { own(undefined, "x"); } catch (error) { console.log("undefined", error instanceof TypeError); }
let rootHolder = false;
const array = JSON.parse("[1,2,3]", function (key, value, context) {
  if (key === "0") this["2"] = undefined;
  if (key === "2") console.log("pending", value === undefined, own(this, "2"), context.source === undefined);
  if (key === "") rootHolder = this[""] === value && own(this, "");
  return value;
});
console.log("root-holder", rootHolder);
console.log("deleted", array[2] === undefined, own(array, "2"), array.length === 3, Object.keys(array).join(","));
const sparse = JSON.parse("[1]", function (key, value) { if (key === "0") this[4000000000] = 8; return value; });
console.log("sparse", sparse.length === 4000000001, own(sparse, "4000000000"), Object.keys(sparse).join(","));
