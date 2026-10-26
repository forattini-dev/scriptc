// @rust-only
// @no-engine
export {};
const values = [1, 2, -3, 4];
let visited = "";
console.log(values.some((value, index, source) => { visited = visited + `${index}:${value}:${source === values};`; return value < 0; }), visited);
const empty: number[] = [];
console.log(empty.some(() => true), values.some(value => value === 99));
function truthy(value: number): unknown { return value === 2 ? "found" : 0; }
console.log(values.some(truthy), [0, 0].some(truthy));
const safe = Number.isSafeInteger;
console.log([1.5, 2].some(safe), [0.5, 1.5].some(safe));
const missing: (number | undefined)[] = [1, undefined, 3];
console.log(missing.some(value => value === undefined));
