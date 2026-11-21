// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />

type ChildView = {
  pid: number;
  kill(signal?: number | NodeJS.Signals): void;
};

function inspect(child: ChildView): void {
  console.log(child.pid > 0);
  if (child.pid < 0) child.kill();
}

function main(): void {
  const child = Bun.spawn(["node", "-e", ""], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  inspect(child);
}

main();
