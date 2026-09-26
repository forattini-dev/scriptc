const table = [2, -0, 1.5, Infinity, -Infinity, 8, NaN];
function read(i: number): number { return table[i] * 1; }
console.log("values", read(0), 1 / read(1), read(2), read(3), read(4), read(5), read(6), read(-0), table.length);
console.log("invalid", read(-1), read(0.5), read(7), read(4294967295), read(1e100), read(NaN), read(Infinity), read(-Infinity));
console.log("tiny", read(Number.MIN_VALUE), read(-Number.MIN_VALUE));
let trace = 0;
function index(): number { trace = trace * 10 + 1; return 2; }
function right(): number { trace = trace * 10 + 2; return 4; }
console.log("order", table[index()] * right(), trace);
function fail(): number { throw new Error("index"); }
try { console.log(table[fail()] * right()); } catch (e) { console.log("throw", (e as Error).message, trace); }
function nested(): number { return table[table[0] * 1] * 2; }
console.log("nested", nested());

const mutated = [3, 5];
function mutateIndex(): number { mutated[0] = 9; return 0; }
console.log("mutation", mutated[mutateIndex()] * 1);
mutated[0.5] = 12;
console.log("numeric-property", mutated[0.5] * 1);
const aliased = [4, 7];
const alias = aliased;
alias[0] = 11;
console.log("alias", aliased[0] * 1);
function update(a: number[]): void { a[0] = 13; }
const passed = [6, 8];
update(passed);
console.log("passed", passed[0] * 1);
const exposed = [1, 2];
function expose(): number[] { return exposed; }
expose()[1] = 15;
console.log("returned", exposed[1] * 1);
const resized = [4, 8];
resized.length = 0;
console.log("resize", resized[1] * 1);
const sparse = [1];
sparse.length = 3;
console.log("hole", sparse[1] * 1);
const callbacks = [17, 18];
function callback(): void { callbacks[0] = 19; }
callback();
console.log("callback", callbacks[0] * 1);
const spreadSource = [2, -0, 1.5, Infinity, -Infinity, 8];
const spread = [...spreadSource];
console.log("spread", spread[2] * 1);

// Initialization stays at its original source position, after prior effects.
let effects = 0;
function mark(): number { effects++; return 21; }
const effectful = [mark(), 22];
console.log("initializer", effectful[0] * 1, effects);
