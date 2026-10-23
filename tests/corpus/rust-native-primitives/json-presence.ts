// @ts-nocheck
// @rust-only
// @no-engine
function present(key: unknown): boolean { return key in (JSON); }
const own = ["parse", "stringify", "rawJSON", "isRawJSON"];
const inherited = ["constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString"];
console.log("own", own.map(present).join(","));
console.log("inherited", inherited.map(present).join(","));
console.log("absent", present(""), present("parseExtra"), present("rawJSON\0"), present("toJSON"), present("prototype"));
console.log("primitive", present(0), present(-0), present(0 / 0), present(true), present(null), present(undefined));
console.log("symbols", present(Symbol.toStringTag), present(Symbol.iterator), present(Symbol("Symbol.toStringTag")), present(Symbol.for("Symbol.toStringTag")));
const high = "😀".slice(0, 1);
console.log("utf16", present(high), present(high + "parse"), present("p😀arse"));
let trace = "";
function key(): string { trace = trace + "K"; return "rawJSON"; }
console.log("once", key() in JSON, trace);
function fail(): string { trace = trace + "T"; throw new Error("key failed"); }
try { console.log(fail() in JSON); }
catch (error) { if (error instanceof Error) console.log("abrupt", error.message, trace); else throw error; }
try { throw Symbol.toStringTag; }
catch (key) { console.log("caught", key in JSON); }
function checked(key: string | number | symbol): boolean { return key in JSON; }
console.log("union", checked("isRawJSON"), checked(3), checked(Symbol.toStringTag));
