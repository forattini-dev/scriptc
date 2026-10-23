/// <reference lib="es2026.json" />
/// <reference lib="es2024.string" />
// @ts-nocheck
// @rust-only
// @no-engine
export {};
interface RawJSON { values: Set<number>; }
const localType: RawJSON = { values: new Set([1, 2]) };
console.log("local type", localType.values.size);
const raw = JSON.rawJSON;
const isRaw = JSON.isRawJSON;
function stringify(value: unknown, replacer: any = undefined, space: any = undefined): string { return JSON.stringify(value, replacer, space) as string; }
function branded(value: unknown): boolean { return isRaw(value) as boolean; }
console.log("functions", raw === JSON.rawJSON, isRaw === JSON.isRawJSON, raw !== isRaw);
const precise = raw("9007199254740993123456789");
console.log("precise", stringify(precise), String(precise.rawJSON), branded(precise));
const spellings = ["-0", "1.2300", "1e+9", "1e400", "true", "false", "null", '"\\u0061"'];
console.log("spellings", spellings.map(value => stringify(raw(value))).join("|"));
console.log("coercion", stringify(raw(null)), stringify(raw(true)), stringify(raw(3)));
const same = precise;
console.log("identity", same === precise, precise === raw("9007199254740993123456789"));
const fake = { rawJSON: "3" };
console.log("brand", branded(fake), branded(null), branded(undefined), branded("3"), branded(3), branded([]), branded(Symbol("raw")), branded(raw));
console.log("prototype", precise.toString === undefined, precise.constructor === undefined, precise.__proto__ === undefined);
console.log("nested", stringify({ value: precise, values: [precise, raw("-0")] }));
console.log("replacer", stringify({ value: 1 }, (key, value) => key === "value" ? raw("1.2300") : value));
console.log("replace raw", stringify(precise, (key, value) => branded(value) ? "replacement" : value));
const hook = { toJSON: (): unknown => raw("7e+2") };
console.log("hook", stringify(hook));
const high = "😀".slice(0, 1);
const rawString = raw('"' + high + '"');
const text: string = stringify(rawString);
console.log("utf16", text.length, text.charCodeAt(1), text.isWellFormed(), rawString.rawJSON === text);
const indented: string = stringify({ key: rawString }, null, high);
console.log("indent", indented.charCodeAt(2), indented.charCodeAt(11), indented.isWellFormed());
let trace = "";
function first(value: unknown): unknown { trace = trace + "A"; return value; }
function extra(): number { trace = trace + "B"; return 0; }
try { raw(first(Symbol("value")), extra()); }
catch (error) { if (error instanceof Error) console.log("symbol", error.name, error.message, trace); else throw error; }
trace = "";
console.log("extra", isRaw(first(precise), extra()) === true, trace);
try { precise.rawJSON = "4"; }
catch (error) { if (error instanceof Error) console.log("frozen", error.name, error.message); else throw error; }
try { precise.other = true; }
catch (error) { if (error instanceof Error) console.log("extend", error.name, error.message); else throw error; }
try { String(precise); }
catch (error) { if (error instanceof Error) console.log("conversion", error.name, error.message); else throw error; }
// JSON parser diagnostics have their own message compatibility work. Here the
// differential contract pins rejection and the exception class.
function rejected(invalid: string): void {
  try { raw(invalid); console.log("unexpected acceptance"); }
  catch (error) { if (error instanceof Error) console.log("invalid", invalid, error.name); else throw error; }
}
rejected(""); rejected(" 1"); rejected("1 "); rejected("{}"); rejected("[]");
rejected("01"); rejected("NaN"); rejected("undefined"); rejected("true false");
