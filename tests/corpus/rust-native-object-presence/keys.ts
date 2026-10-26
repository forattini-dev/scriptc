// @ts-nocheck
// @rust-only
// @no-engine
function has(key: unknown, value: unknown): boolean { return key in value; }
const object = { "0": "zero", "true": 1, "null": 2, "undefined": 3, "NaN": 4, "Infinity": 5, "12": 6 };
console.log("primitive", has(-0, object), has(true, object), has(null, object), has(undefined, object), has(Number.NaN, object), has(Number.POSITIVE_INFINITY, object), has(12n, object));
console.log("absent", has(false, object), has(1, object), has(-1n, object));
console.log("symbols", has(Symbol("0"), object), has(Symbol.for("toString"), object), has(Symbol.toStringTag, object));
const high = "😀".slice(0, 1);
const keys: Record<string, number> = {};
keys[high] = 1;
keys["x\0y"] = 2;
keys["😀"] = 3;
console.log("utf16", has(high, keys), has("x\0y", keys), has("😀", keys), has(high + "x", keys), has("x", keys));
function checked(key: string | number | symbol, value: {name?: string}): boolean { return key in value; }
console.log("typed", checked("name", {name: undefined}), checked(0, {}), checked(Symbol("name"), {name: "yes"}));
try { throw "null"; } catch (key) { console.log("caught-key", key in object); }
try { throw object; } catch (value) { console.log("caught-object", "0" in value, "missing" in value, value === object); }
