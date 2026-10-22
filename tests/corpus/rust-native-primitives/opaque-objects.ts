// @rust-only
// @no-engine
import { echo, relay } from "./opaque-library.mjs";
function pass(value: Object): Object { return value; }
function object(value: object): object { return value; }
function maybe(value: object | null): unknown { return value; }
const record = { count: 42 };
const array = [1, 2];
const callback = (value: number): number => value + 1;
console.log("identity", pass(record) === record, object(record) === record, relay(record) === record, echo(record) === record);
console.log("arrays", pass(array) === array, Array.isArray(pass(array)), Array.isArray(object(array)), echo(array) === array);
console.log("functions", pass(callback) === callback, object(callback) === callback, typeof relay(callback));
console.log("primitives", pass(3) === 3, pass("text") === "text", pass(true) === true);
const symbol = Symbol("value");
console.log("symbol", pass(symbol) === symbol, typeof pass(symbol));
console.log("nullable", maybe(null) === null, maybe(record) === record);
function shadow(): void {
  interface Object { count: number; values: Set<number> }
  const read = (value: Object): number => value.count + value.values.size;
  console.log("shadow", read({ count: 40, values: new Set<number>([1, 2]) }));
}
shadow();
