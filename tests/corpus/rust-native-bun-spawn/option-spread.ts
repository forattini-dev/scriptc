// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />

async function main(): Promise<void> {
  const extra: { env?: NodeJS.ProcessEnv; cwd?: string } = {
    env: { ...process.env, SCRIPTC_SPAWN_SPREAD: "yes" },
  };
  const child = Bun.spawn([
    "node",
    "-e",
    "process.exit(process.env.SCRIPTC_SPAWN_SPREAD === 'yes' ? 4 : 9)",
  ], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    ...extra,
  });
  console.log(await child.exited);
}

void main();
