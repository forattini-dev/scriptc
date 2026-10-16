// @rust-only
// @no-engine
import { twice as imported } from "./barrel.ts";
import "./dependency.ts";
import type { Erased } from "./type-only.ts";
console.log("entry", imported(21), even(8));
const alias = odd;
console.log("alias", alias(3));
function even(n: number): boolean { if (n === 0) { return true; } return odd(n - 1); }
function odd(n: number): boolean { if (n === 0) { return false; } return even(n - 1); }
export async function unusedAsync(): Promise<number> { return 42; }
function unusedGeneric<T>(value: T): T { return value; }
function unusedArray(records: readonly { value: number }[]): number { return records.length; }
function unusedLoop(): number { while (true) { return 1; } }
function unusedCycleA(): number { return unusedCycleB(); }
function unusedCycleB(): number { return unusedCycleA(); }
// The source is still checked; the unused declaration needs no native signature.
const erased: Erased = "erased";
console.log(erased);
