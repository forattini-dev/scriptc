// @rust-only
// @no-engine
/// <reference types="node" />
export {};
async function failure(): Promise<number> { throw "module failure"; }
process.exit(await failure());
