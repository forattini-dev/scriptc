// @target bun
// The bun target's identity probe: process.versions.bun answers the pinned
// bun build (compat/runtime-target.ts BUN_VERSION) so runtime-detection
// ladders take Bun's arm; under a Node target the same read is undefined
// (Node's own answer). The oracle is the pinned bun binary itself.
console.log(process.versions.bun);
console.log(typeof process.versions.bun);
