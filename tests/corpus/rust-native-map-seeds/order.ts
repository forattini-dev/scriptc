// @rust-only
// @no-engine
const source = [1, 2];
let receiverCalls = 0;
let factoryCalls = 0;
function receiver(): number[] { receiverCalls = receiverCalls + 1; console.log("receiver"); return source; }
function callback(): (value: number, index: number, array: number[]) => [number, number] {
  factoryCalls = factoryCalls + 1;
  console.log("factory");
  source.push(3);
  return (value, index, array) => {
    console.log("callback", value, index, array === source);
    array.push(100 + index);
    return [value, index];
  };
}
const map = new Map(receiver().map(callback()));
console.log("length", source.length, map.size, receiverCalls, factoryCalls, map.get(3) === 2, map.has(100));
let captured = 0;
function capture(): number[] {
  let local = 10;
  return [1, 2].map(value => { local = local + value; captured = local; return local; });
}
const values = capture();
console.log("capture", values[0], values[1], captured);
let reads = 0;
function pair(): readonly [number, string] { reads = reads + 1; return [1, "one"] as const; }
console.log("tuple-length", pair().length, reads);
const readonlyPairs: readonly (readonly [number, string])[] = [pair(), [2, "two"] as const];
const readonlyMap = new Map(readonlyPairs);
console.log("readonly", readonlyMap.size, readonlyMap.get(1) === "one", reads);
function key(value: number): number { console.log("key", value); return value; }
const duplicate = new Map([1, 2, 3].map(value => [key(value === 3 ? 1 : value), value]));
console.log("duplicates", duplicate.size, duplicate.get(1) === 3);
const zeros = new Map([-0, 0, 0 / 0, 0 / 0].map((value, index) => [value, index]));
console.log("same-value-zero", zeros.size, zeros.get(0) === 1, zeros.get(0 / 0) === 3);
const appending = [1];
function item(): number { console.log("argument", appending.length); return 9; }
console.log("push", appending.push(item(), item()), appending.push(), appending.length);
