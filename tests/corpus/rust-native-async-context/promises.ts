// @rust-only
// @no-engine
import { AsyncLocalStorage } from "node:async_hooks";
const storage = new AsyncLocalStorage<string>();
const shared = Promise.resolve(1);
storage.run("A", () => { shared.then(() => { console.log("reaction A", storage.getStore() === "A"); }); });
storage.run("B", () => { shared.then(() => { console.log("reaction B", storage.getStore() === "B"); }); });
shared.then(() => { console.log("outside reaction", storage.getStore() === undefined); });
const result = storage.run("prefix", async () => {
  console.log("eager prefix", storage.getStore() === "prefix");
  Promise.resolve(2).then(() => { console.log("prefix reaction", storage.getStore() === "prefix"); });
  return 9;
});
result.then(value => { console.log("returned promise", value, storage.getStore() === undefined); });
console.log("after run", storage.getStore() === undefined);
