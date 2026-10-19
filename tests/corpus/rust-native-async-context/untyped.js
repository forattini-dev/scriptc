// @rust-only
// @no-engine
import { AsyncLocalStorage } from "node:async_hooks";
const storage = new AsyncLocalStorage();
function run(value, callback) { return storage.run(value, callback); }
function active() { return storage.getStore(); }
const scope = { id: 7 };
console.log("initial", active() === undefined);
const result = run(scope, () => { console.log("JS scope", active() === scope); return scope; });
console.log("JS result", result === scope, active() === undefined);
function scheduleCycle() {
  let value = null;
  const read = () => value;
  const cycle = { read };
  value = cycle;
  storage.run(cycle, () => {
    Promise.resolve(1).then(() => {
      console.log("context owning cycle", active() === cycle, read() === cycle);
    });
  });
  return true;
}
scheduleCycle();
