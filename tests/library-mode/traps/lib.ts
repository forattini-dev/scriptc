// K5/K6/K7 fixture: a deliberately trapping export (array index OOB — the
// runtime's own range trap), a throwing export (the escaped-exception
// channel: "Uncaught ..." rendered into the sink), and a benign export the
// poisoned-library probe calls after a trap (which must abort, never run).
// Keep the range-trap input owned by the library. A host longjmp cannot
// unwind local RC owners; a poisoned instance deliberately has no teardown
// contract. K10 checks trap delivery under ASan without abandoning a local
// heap allocation as an incidental part of the fixture.
const xs = [1, 2, 3];
export function boom(i: number): number {
  return xs[i]!;
}

export function fail(msg: string): number {
  throw new Error(msg);
}

export function ok(x: number): number {
  return x + 1;
}

console.log("traps ready");
