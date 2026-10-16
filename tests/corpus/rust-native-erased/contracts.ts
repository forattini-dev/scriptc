function identity<T>(value: T): T { return value; }
console.log(identity(7), identity("native"), identity(true));
const same = identity;
console.log(same("alias"));
const record = { value: "retained" };
const returned = identity(record);
console.log(returned === record, returned.value);
record.value = "mutated";
console.log(returned.value);
const payload: unknown = { text: "data", nested: [1, "two", null] };
function retain(value: unknown): unknown { return value; }
const alias = retain(payload);
console.log(payload === alias, (alias as any).text === "data");
const array: unknown = [1, "two", null];
console.log((array as any).length === 3, (array as any)["1"] === "two");
const callback = (value: number): number => value + 1;
const recovered = identity(callback);
console.log(recovered(4), recovered === callback);
function fallback(value: unknown = "default"): unknown { return value; }
console.log(fallback() === "default", fallback(null) === null, fallback(false) === false);

// Former refusal cases now exercise native erasure instead.
function f<T>(n: T) { return n; } console.log(f(1));
class Fault extends Error { context: unknown; constructor(value: unknown) { super(); this.context = value; } }
const fault = new Fault(1);
console.log(fault.context === 1);

function classify(value: unknown): number {
  if (typeof value === "number") { return value + 1; }
  return 0;
}
console.log("narrowed", classify(4), classify("word"));

const numbers = [1, 2, 3];
const erasedArray: unknown = numbers;
console.log("array", (erasedArray as any).length === 3, (erasedArray as any)["1"] === 2, (erasedArray as any)["8"] === undefined);
const mixed = identity<unknown[]>([1, "two", undefined]);
console.log("mixed", mixed.length, mixed[1] === "two");
function collectCycle(): void {
  const node: { next: unknown } = { next: undefined };
  node.next = node;
  console.log("cycle", node.next === node);
}
collectCycle();
