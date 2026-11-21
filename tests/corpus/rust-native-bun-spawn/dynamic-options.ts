// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />

function stdinMode(): "ignore" {
  return "ignore";
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const extra: { cwd?: string } = { cwd };
  const child = Bun.spawn(["node", "-e", "process.stdout.write(process.cwd())"], {
    stdin: stdinMode(),
    stdout: "pipe",
    stderr: "ignore",
    ...extra,
  });
  const output = await new Response(child.stdout).text();
  console.log(output === cwd);
}

void main();
