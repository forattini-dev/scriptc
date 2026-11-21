console.log("entry:start");
import("./dynamic-lazy-discarded-lib.ts");
void Promise.resolve().then(() => console.log("entry:microtask"));
console.log("entry:end");
