// @rust-only
// @no-engine
export {};

let calls = 0;
function make(): number[] { calls++; return [10, 11]; }
function test() {
  const [, ...once] = make();
  console.log("once", calls, once.length, once[0] === 11);

  const original = [1, 2, 3];
  const [head, ...tail] = original;
  original[1] = 7;
  console.log("basic", head, tail.length, tail[0] === 2, tail[1] === 3, original[1]);

  const short: number[] = [9];
  const [first, second, ...empty] = short;
  console.log("short", first, second === undefined, empty.length);
  const [kept, ,] = short;
  console.log("omitted", kept);

  const sparse: any[] = [1, 2, 3];
  delete sparse[1];
  const [, ...dense] = sparse;
  console.log("holes", dense.length, Object.keys(dense).join("|"), dense[0] === undefined, dense[1] === 3);

  const nested: any[] = [{ value: 1 }, 2];
  const [...copy] = nested;
  console.log("identity", copy[0] === nested[0], copy !== nested);

  for (const [item, ...others] of [[4, 5], [6]]) {
    console.log("loop", item, others.length, others[0] === 5);
  }
}
function parameter([first, ...tail]: number[]) {
  console.log("parameter", first, tail.length, tail[0] === 8);
}
test();
parameter([7, 8]);
