// Immediate numeric reads avoid boxing but retain JavaScript array and
// evaluation-order semantics, including holes and non-index properties.
const values: number[] = [-0, 1.5, NaN, Infinity, -Infinity];
console.log("ieee", 1 / (values[0] * 1), values[1] + 2, values[2] * 3, values[3] - 1, values[4] / 2);
console.log("operators", values[1] ** 2, values[1] % 1, values[1] | 4, values[1] << 2);
console.log("missing", values[20] + 1, values[20] * 0, values[20] < 1, values[20] | 7);
console.log("observable", values[20] === undefined, values[20] === values[21], values[20] ?? 9);
console.log("concat", values[20] + "!", "value:" + values[1]);

values.length = 8;
values[6] = values[20];
console.log("states", values[5] + 1, values[6] + 1, 5 in values, 6 in values);
values[5] = 12;
values[1] = values[20];
console.log("mutated", values[5] - 2, values[1] * 2);
values.length = 1;
console.log("truncated", values[5] + 1);

values[-1] = 4;
values[0.5] = 5;
values[4294967295] = 6;
values[NaN] = 7;
values[Infinity] = 8;
console.log("properties", values[-1] + 1, values[0.5] * 2, values[4294967295] - 1, values[NaN] / 2, values[Infinity] + 1);
values[-1] = values[20];
console.log("property-missing", values[-1] * 2, values[-2] + 1, values[-Infinity] + 1);
const sparse: number[] = [];
sparse[1000000] = 9;
console.log("sparse", sparse[1000000] * 2, sparse[999999] + 1);

let trace = "";
const original = [10];
const replacement = [100];
let current = original;
function receiver(): number[] { trace += "R"; return current; }
function index(): number { trace += "I"; current = replacement; original[0] = 12; return 0; }
function rhs(): number { trace += "V"; original[0] = 40; return 3; }
const result = receiver()[index()] + rhs();
console.log("order", result, trace, original[0], current[0]);

trace = "";
function temporary(): number[] { trace += "T"; return [6]; }
function zero(): number { trace += "Z"; return 0; }
console.log("temporary", temporary()[zero()] * temporary()[zero()], trace);
trace = "";
console.log("short-circuit", false && temporary()[zero()] > 0, true || temporary()[zero()] > 0, trace);
function fail(): number { trace += "F"; throw new Error("index"); }
try { console.log(temporary()[fail()] + rhs()); } catch { console.log("throw", trace); }

// Wider unions, saved reads, and user functions keep their tagged value.
const saved = values[20];
values[20] = 4;
console.log("saved", saved === undefined, saved + 1, values[20] + 1);
const mixed: (number | string)[] = [3, "x"];
const first = mixed[0];
if (typeof first === "number") console.log("mixed", first + 1);
function userRead(a: number[], i: number): number { return a[i]; }
console.log("user-call", userRead(values, 0) * 1);
