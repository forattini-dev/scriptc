// @no-engine
// @rust-only
import { strictEqual } from "node:assert";
function same(left: unknown, right: unknown): void { strictEqual(left, right); }
async function load(): Promise<unknown> { return import("./module.ts"); }
const original = import("./module.ts");
const widened: Promise<unknown> = original;
const value = await widened;
const second: unknown = await original;
same(value, second);
same(await load(), value);
console.log(typeof value, JSON.stringify(value), "shared namespace");
