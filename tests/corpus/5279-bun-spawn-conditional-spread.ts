// @rust-only
// @target bun
// @no-engine
/// <reference path="rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />

export {};

async function capture(env?: NodeJS.ProcessEnv): Promise<number> {
  const child = Bun.spawn(
    [
      "node",
      "-e",
      "process.exit(process.env.SCRIPTC_CONDITIONAL_SPREAD === 'yes' ? 6 : 9)",
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      ...(env ? { env } : {}),
    },
  );
  return await child.exited;
}

async function main(): Promise<void> {
  console.log(await capture({ ...process.env, SCRIPTC_CONDITIONAL_SPREAD: "yes" }));
}

void main();
