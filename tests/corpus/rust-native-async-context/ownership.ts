// @rust-only
// @no-engine
import { AsyncLocalStorage } from "node:async_hooks";
const records = new AsyncLocalStorage<{ count: number }>();
const value = { count: 3 };
const result = records.run(value, () => {
  console.log("same record", records.getStore() === value);
  Promise.resolve(1).then(() => {
    const stored = records.getStore();
    if (stored !== undefined) console.log("queued record", stored === value, stored.count);
  });
  return records.getStore();
});
console.log("return identity", result === value, records.getStore() === undefined);
value.count = 8;
const callbacks = new AsyncLocalStorage<() => number>();
const callback = () => 5;
const stored = callbacks.run(callback, () => callbacks.getStore());
console.log("callback identity", stored === callback);
if (stored !== undefined) console.log("callback value", stored());
