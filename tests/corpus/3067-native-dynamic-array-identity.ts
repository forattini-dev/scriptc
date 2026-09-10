// @rust-only
// @no-engine
function box(values: number[]): unknown { return values; }
function unbox(value: unknown): number[] { return value as number[]; }
const values: number[] = [1, 2];
const boxed = box(values);
const returned = unbox(boxed);
console.log("typed", values === returned, box(values) === boxed);
returned.push(3);
console.log("write", values.join(","));
const dynamic: unknown = JSON.parse("[4,5]");
const first = unbox(dynamic);
const second = unbox(dynamic);
console.log("dynamic", first === second, box(first) === dynamic);
first[0] = 6;
second.push(7);
console.log("mutations", JSON.stringify(dynamic), first.join(","));
first.reverse();
// Narrowing an unknown array exercises the native dynamic mutation path.
function mutate(value: unknown): void {
  if (Array.isArray(value)) {
    value.splice(1, 1, 8, 9);
    value.fill(2, 1, 2);
    value.copyWithin(2, 0, 1);
  }
}
mutate(second);
console.log("bulk", JSON.stringify(dynamic));
mutate(values);
console.log("typed backing", values.join(","));
const matrix: unknown = JSON.parse("[[1,2],[3]]");
const nested = matrix as number[][];
const nestedAgain = matrix as number[][];
console.log("nested", nested === nestedAgain, nested[0] === nestedAgain[0]);
nested[0].push(4);
nestedAgain[1][0] = 5;
console.log("nested write", JSON.stringify(matrix));
console.log("contains", nested.includes(nestedAgain[0]), nested.indexOf(nestedAgain[1]));
const cycle: unknown[] = [];
cycle.push(cycle);
console.log("cycle", cycle[0] === cycle);
try { JSON.stringify(cycle); } catch (error) { console.log("cycle json", error instanceof TypeError); }

// Dynamic literals must use their contextual element type, including spreads.
const flexible: unknown[] = [1, 2];
flexible.push("three");
const spread: unknown[] = [...nested];
spread.push("tail");
console.log("literal", JSON.stringify(flexible), (spread[0] as number[]) === nested[0], JSON.stringify(spread));

const wrapped: unknown[] = [[1], 2];
const wrappedInner = wrapped[0];
if (Array.isArray(wrappedInner)) wrappedInner.push("two");
console.log("union literal", JSON.stringify(wrapped));
