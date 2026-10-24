// @rust-only
// @no-engine
const table: Record<number, string> = { 2: "two" };
const inferred = table[99];
const optional: string | undefined = table[99];
function captured(): string | undefined { return inferred; }
function annotated(): string | undefined { return optional; }
console.log("capture", captured(), annotated(), inferred, optional);
function local(key: number): string {
  const inferred = table[key];
  const annotated: string | undefined = table[key];
  if (inferred === undefined || annotated === undefined) { return "missing"; }
  return inferred + annotated;
}
console.log("locals", local(2), local(99));
const readonly: Readonly<Record<number, string>> = table;
table[3] = "three";
console.log("readonly view", readonly[3], readonly[99], readonly === table);
const arrays: Record<number, string[] | undefined> = { 1: ["first"], 2: undefined };
const array = arrays[1];
if (array !== undefined) { console.log("array", array.length, array[0] === "first"); }
console.log("array absence", arrays[2] === undefined, arrays[3] === undefined);
let count = 0;
function receiver(): Record<number, string> { count = count + 1; return table; }
function fail(): number { throw new Error("key"); }
try { receiver()[fail()] = "unwritten"; }
catch (error) { if (error instanceof Error) console.log("key error", count, error.message); else throw error; }

let mutable: string | undefined = table[2];
function clear(): boolean { mutable = undefined; return true; }
if (mutable !== undefined && clear()) { console.log("call invalidates", mutable, mutable === undefined); }
const required: Record<number, string[]> = { 1: ["first"] };
console.log("nested", required[1][0] === "first", required[1][99] === undefined);
count = 0;
function missingKey(): number { count = count + 1; return 0; }
try { required[99][missingKey()]; }
catch (error) { if (error instanceof Error) console.log("nested missing", count, error.name, error.message); else throw error; }
