// @rust-only
// @no-engine
import { AsyncLocalStorage as RealStorage } from "node:async_hooks";
class AsyncLocalStorage {
  value: string = "source";
  getStore(): string { return this.value; }
  run(value: string, callback: () => string): string { return callback(); }
}
const source = new AsyncLocalStorage();
const real = new RealStorage<string>();
console.log("source", source.getStore(), source.run("unused", () => "callback"));
console.log("native", real.getStore() === undefined, real.run("value", () => real.getStore() === "value"));
