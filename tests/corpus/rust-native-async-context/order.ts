// @rust-only
// @no-engine
import { AsyncLocalStorage } from "node:async_hooks";
const storage = new AsyncLocalStorage<string>();
function receiver(): AsyncLocalStorage<string> { console.log("receiver", storage.getStore() === "outer"); return storage; }
function value(): string { console.log("value", storage.getStore() === "outer"); return "inner"; }
function callback(): (value: number) => boolean {
  console.log("callback factory", storage.getStore() === "outer");
  return (value: number) => { console.log("callback", value, storage.getStore() === "inner"); return true; };
}
function argument(): number { console.log("argument", storage.getStore() === "outer"); return 7; }
storage.run("outer", () => { console.log("result", receiver().run(value(), callback(), argument())); });
console.log("outside", storage.getStore() === undefined);
