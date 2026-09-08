export * from "./left.ts";
export * from "./right.ts";
export * from "./override.ts";
// This explicit export resolves the different label bindings from the stars.
export { label } from "./override.ts";
export { counter as aliasCounter, bump as aliasBump, default as snapshot } from "./base.ts";
console.log("diamond evaluated");
