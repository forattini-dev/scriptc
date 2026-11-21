// @rust-only
// @no-engine
/// <reference types="node" />
export {};
console.log("before exit");
process.exit(await Promise.resolve(7));
