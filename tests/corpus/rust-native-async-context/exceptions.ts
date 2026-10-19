// @rust-only
// @no-engine
import { AsyncLocalStorage } from "node:async_hooks";
const storage = new AsyncLocalStorage<string | undefined>();
storage.run("outer", () => {
  try {
    storage.run("inner", () => { console.log("throw inside", storage.getStore() === "inner"); throw "failure"; });
  } catch (error) { console.log("caught", error === "failure", storage.getStore() === "outer"); }
  storage.run(undefined, () => { console.log("stored undefined", storage.getStore() === undefined); });
  console.log("outer restored", storage.getStore() === "outer");
});
function broken(): number { console.log("argument throws", storage.getStore() === undefined); throw "argument"; }
try { storage.run("unused", (value: number) => value, broken()); }
catch (error) { console.log("argument caught", error === "argument", storage.getStore() === undefined); }
console.log("outside", storage.getStore() === undefined);
function fail(): never { throw "named"; }
try { storage.run("named scope", fail); }
catch (error) { console.log("named never", error === "named", storage.getStore() === undefined); }
