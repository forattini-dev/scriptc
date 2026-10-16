// @rust-only
// @no-engine
interface Operation { key: string; count: number }
const operations: Operation[] = [{ key: "same", count: 1 }, { key: "other", count: 2 }, { key: "same", count: 3 }];
let calls = 0;
const registry: ReadonlyMap<string, Operation> = new Map(operations.map((operation, index, source) => {
  calls = calls + 1;
  console.log("visit", index, source === operations, operation.count);
  return [operation.key, operation];
}));
console.log("registry", calls, registry.size);
const same = registry.get("same");
if (same !== undefined) console.log(same === operations[2], same.count);
operations[2].count = 42;
const after = registry.get("same");
if (after !== undefined) console.log(after.count);
const pairs: [string, Operation][] = operations.map(operation => [operation.key, operation]);
const copy = new Map<string, Operation>(pairs);
console.log("stored", copy.size, pairs.length, pairs[0][0] === "same", pairs[0][1] === operations[0]);
const empty: Operation[] = [];
const emptyMap = new Map<string, Operation>(empty.map(operation => [operation.key, operation]));
console.log("empty", emptyMap.size);
const scalar = [1, 2, 3].map((value, index) => value * 10 + index);
console.log("scalar", scalar.length, scalar[0], scalar[2]);
const strings = [1, 2].map(() => "native");
console.log("strings", strings.length, strings[0] === "native");
function mapper(value: number): [number, number] { return [value, value * 2]; }
const numeric = new Map([1, 2, 1].map(mapper));
console.log("named", numeric.size, numeric.get(2) === 4);
const nested = [1, 2].map(value => [value].map(item => item * 2));
console.log("nested", nested[0][0], nested[1][0]);
