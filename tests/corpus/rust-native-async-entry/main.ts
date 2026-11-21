// @rust-only
// @no-engine
/// <reference types="node" />
import "./dep.ts";
console.log("before");
Promise.resolve(0).then(() => { console.log("microtask"); });
async function run(): Promise<number> {
  console.log("run");
  return 0;
}
process.exit(await run());
