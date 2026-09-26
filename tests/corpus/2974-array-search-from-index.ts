const values = [1, 2, 1, NaN, -0];
for (const start of [0, -0, 1, 1.9, -1, -1.9, -5, -6, 5, 9, NaN, Infinity, -Infinity]) {
  console.log(start, values.indexOf(1, start), values.includes(1, start));
  console.log(values.indexOf(NaN, start), values.includes(NaN, start));
  console.log(values.indexOf(0, start), values.includes(0, start));
}
console.log(values.indexOf(1, undefined), values.includes(1, undefined));
function search(start?: number): void {
  console.log(values.indexOf(1, start), values.includes(1, start));
}
search();
search(2);

const sparse: (number | undefined)[] = [];
sparse[1] = undefined;
sparse[3] = 7;
sparse[1_000_000_000] = 9;
console.log(sparse.indexOf(undefined, 1), sparse.indexOf(undefined, 2));
console.log(sparse.includes(undefined, 2), sparse.includes(undefined, 1_000_000_000));
console.log(sparse.indexOf(9, 100), sparse.indexOf(9, -1), sparse.includes(9, -1));

console.log(["a", "b", "a"].indexOf("a", 1), ["a", "b", "a"].includes("b", -1));
console.log([false, true, false].indexOf(false, 1), [false, true].includes(false, 1));
console.log([1n, 2n, 1n].indexOf(1n, 1), [1n, 2n].includes(1n, -1));
const first = [1];
const second = [2];
const refs = [first, second, first];
console.log(refs.indexOf(first, 1), refs.includes(first, -1), refs.indexOf([1], 0));

// Every operand runs once, in receiver/needle/start order. Argument effects
// happen before the method captures the array length.
let trace = "";
const growing = [1];
function receiver(): number[] { trace += "r"; return growing; }
function needle(): number { trace += "n"; return 2; }
function start(): number { trace += "s"; growing.push(2); return -1; }
console.log(receiver().indexOf(needle(), start()), trace);
trace = "";
console.log(receiver().includes(needle(), void start()), trace);
