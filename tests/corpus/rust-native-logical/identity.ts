// @rust-only
// @no-engine
const first = {value: 1};
const second = {value: 2};
function choose(left: {value: number}, right: {value: number}): {value: number} { return left || right; }
const selected = choose(first, second);
selected.value = 7;
console.log("record", selected === first, first.value);
const a = [1]; const b = [2];
function array(left: number[], right: number[]): number[] { return left && right; }
console.log("array", array(a, b) === b);
const fn = (): number => 9;
function callback(left: any, right: () => number): () => number { return left && right; }
console.log("callback", callback(true, fn) === fn, callback(true, fn)());
console.log("mixed", (false && first) === false, (true && first) === first);
