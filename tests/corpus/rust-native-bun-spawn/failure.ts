// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />
try {
  Bun.spawn([]);
  console.log("unexpected");
} catch (error) {
  console.log("type error", error instanceof TypeError);
}
