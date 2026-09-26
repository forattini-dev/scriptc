// Retain the evaluated receiver until a side-effecting index finishes,
// including when that index replaces the array's only other reference.
let current: number[] = [12, -0];
let calls = 0;
function replace(): number {
  calls++;
  current = [90];
  return 0;
}
console.log("replace", current[replace()] + 1, current[0], calls);

function nested(): number {
  const before = current[replace()] * 2;
  current = [30];
  return before > 0 ? 0 : 1;
}
console.log("nested", current[nested()] - 1, current[0], calls);

let trace = "";
function temporary(): number[] { trace += "R"; return [7]; }
function fail(): number { trace += "I"; throw new Error("index"); }
function rhs(): number { trace += "V"; return 1; }
try { console.log(temporary()[fail()] + rhs()); } catch { console.log("throw", trace); }

// Cover the array-index boundary without allocating dense 2^32 storage.
const sparse: number[] = [-0];
sparse[4294967294] = Infinity;
sparse[4294967295] = -Infinity;
console.log("boundary", sparse.length, sparse[4294967294] + 1, sparse[4294967295] - 1, sparse[4294967293] * 2);
console.log("zero-index", 1 / (sparse[-0] * 1));
sparse[4294967294] = sparse[2];
console.log("undefined", sparse[4294967294] + 1, 4294967294 in sparse);
sparse.length = 1;
console.log("truncate", sparse[4294967294] + 1, sparse[4294967295] - 1);
