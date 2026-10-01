// @rust-only
// @no-engine
// A nested bracket access evaluates its key before rejecting an absent
// outer slot, and reports that key in Node's catchable TypeError.
let trace = "";
const matrix: number[][] = [[3]];
matrix.length = 2;
const pairs: [string, string][] = [["a", "b"]];
const views: Uint8Array[] = [new Uint8Array([7])];
function matrices(): number[][] {
  trace += "r";
  return matrix;
}
function tuples(): [string, string][] {
  trace += "r";
  return pairs;
}
function bytes(): Uint8Array[] {
  trace += "r";
  return views;
}
function outer(index: number): number {
  trace += "i";
  return index;
}
function key(fail: boolean): number {
  trace += "k";
  if (fail) throw new Error("key failed");
  return 0;
}
function read(index: number, fail: boolean): void {
  trace = "";
  try {
    console.log("matrix", (matrices()[outer(index)])[key(fail)]);
  } catch (error) {
    console.log("matrix-error", error instanceof TypeError, (error as Error).message);
  }
  console.log("trace", trace);
}
read(0, false);
read(1, false);
read(7, false);
read(7, true);
for (const index of [0, 1]) {
  trace = "";
  try {
    console.log("tuple", tuples()[outer(index)][key(false)]);
  } catch (error) {
    console.log("tuple-error", error instanceof TypeError, (error as Error).message);
  }
  console.log("trace", trace);
  trace = "";
  try {
    console.log("bytes", bytes()[outer(index)][key(false)]);
  } catch (error) {
    console.log("bytes-error", error instanceof TypeError, (error as Error).message);
  }
  console.log("trace", trace);
}
