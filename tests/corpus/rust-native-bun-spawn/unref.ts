// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />

const child = Bun.spawn(["node", "-e", ""], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
// The pinned local Bun declarations predate Subprocess.unref; current Bun and
// the red-dev target expose it on this same native handle.
// @ts-ignore
child.unref();
console.log("unref", child.pid > 0);
