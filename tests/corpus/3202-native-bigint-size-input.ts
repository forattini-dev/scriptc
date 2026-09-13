// @rust-only
// @no-engine
import type { Size, SizeInput } from "effect/FileSystem";

function describe(value: SizeInput): string {
  if (typeof value === "bigint") return "bigint:" + String(value + 1n);
  return "number:" + String(value + 1);
}
function brand(value: bigint): Size { return value as Size; }
console.log(describe(brand(9007199254740993n)), describe(12n), describe(7));
function optional(value: bigint | undefined): string {
  if (value === undefined) return "absent";
  return value.toString();
}
console.log(optional(undefined), optional(123n));
function equal(value: bigint | number): boolean { return value === 12n; }
console.log(equal(12n), equal(12), equal(13n));
