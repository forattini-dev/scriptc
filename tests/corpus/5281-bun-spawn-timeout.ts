// @rust-only
// @target bun
// @no-engine
/// <reference path="rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />

export {};

async function main(): Promise<void> {
  const child = Bun.spawn(
    ["node", "-e", "setTimeout(() => process.exit(0), 5000)"],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 50,
    },
  );
  console.log((await child.exited) !== 0);
}

void main();
