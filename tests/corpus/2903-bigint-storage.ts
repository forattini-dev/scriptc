const values: bigint[] = [0n, 1n, 123456789012345678901234567890n];
values.push(-5n);
console.log("array", values.length, values[2], values.indexOf(1n), values.includes(123456789012345678901234567890n));

type Box = { value: bigint; label: string };
const box: Box = { value: 1n << 96n, label: "wide" };
console.log("record", box.label, box.value);

class Counter {
  value: bigint;
  constructor(value: bigint) { this.value = value; }
  add(step: bigint): bigint { this.value = this.value + step; return this.value; }
}
const counter = new Counter(10n ** 30n);
console.log("class", counter.add(7n));

function capture(value: bigint): () => bigint { return () => value + 1n; }
console.log("closure", capture(999999999999999999999n)());

function describe(value: bigint | string): string {
  if (typeof value === "bigint") return value === 0n ? "zero" : `${value}`;
  return value;
}
console.log("union", describe(0n), describe(42n), describe("text"));

async function later(value: bigint): Promise<bigint> { return value * 2n; }
console.log("promise", await later(12345678901234567890n));
