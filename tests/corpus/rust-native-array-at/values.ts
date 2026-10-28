// @rust-only
// @no-engine
export {};
const values = ["a", "b", "c"];
console.log("ordinary", values.at(0), values.at(-1), values.at(-3), values.at(3) === undefined, values.at(-4) === undefined);
console.log("numeric", values.at(1.8), values.at(-1.8), values.at(NaN), values.at(Infinity) === undefined, values.at(-Infinity) === undefined);
const empty: string[] = [];
console.log("empty", empty.at(0) === undefined, empty.at(-1) === undefined);
let effects = "";
const array = ["first", "last"];
function receiver(): string[] { effects += "r"; return array; }
function index(): number { effects += "i"; array.push("new"); return -1; }
console.log("order", receiver().at(index()), effects);
const sparse: any[] = ["x", "y"];
delete sparse[1];
console.log("hole", sparse.at(-1) === undefined, String(sparse.at(0)));
const numbers: readonly number[] = [3, 8];
console.log("readonly", numbers.at(-0), numbers.at(-1), numbers.at(9) === undefined);
const mixed: (number | null)[] = [null, 9];
console.log("union", mixed.at(0) === null, mixed.at(-1), mixed.at(2) === undefined);
