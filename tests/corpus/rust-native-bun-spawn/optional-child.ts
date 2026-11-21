// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />

async function main(): Promise<void> {
  let child: Bun.Subprocess | undefined;
  child = Bun.spawn(["node", "-e", "process.exit(3)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  console.log(await child.exited);
}

void main();
