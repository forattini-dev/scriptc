// @rust-only
// @no-engine
import { AsyncLocalStorage } from "node:async_hooks";
const first = new AsyncLocalStorage<string>();
const second = new AsyncLocalStorage<string>();
const alias = first;
console.log("identity", first === alias, first === second, typeof first);
console.log("outside", first.getStore() === undefined, second.getStore() === undefined);
const result = first.run("outer", () => {
  console.log("outer", alias.getStore() === "outer", second.getStore() === undefined);
  first.run("inner", () => { console.log("inner", first.getStore() === "inner"); });
  console.log("restored", first.getStore() === "outer");
  return second.run("other", (a: number, b: number) => {
    console.log("independent", first.getStore() === "outer", second.getStore() === "other");
    return a + b;
  }, 4, 5);
});
console.log("return", result, first.getStore() === undefined, second.getStore() === undefined);
