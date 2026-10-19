// @rust-only
// @no-engine
import * as counter from "./counter.ts";
let cached: typeof import("./counter.ts") | null = null;
console.log("empty", cached === null);
cached = counter;
const saved = cached;
console.log("identity", saved === counter, saved.count, saved.read());
counter.set(4);
console.log("live", saved.count, saved.read());
saved.set(8);
console.log("after", counter.count, counter.read());
function identity(value: typeof counter): typeof counter { return value; }
const values: (typeof counter)[] = [saved, counter];
const holder: { value: typeof counter } = { value: saved };
console.log("containers", values[0] === counter, holder.value === values[1], identity(holder.value).count);
function callback(): () => typeof counter { const alias = counter; return () => alias; }
console.log("callback", callback()() === counter, callback()().read());
