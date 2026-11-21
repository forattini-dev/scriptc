/// <reference path="./rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />

async function runtimeEnvironment(): Promise<Record<string, string>> {
  return { SCRIPTC_CHILD_ENV: "native" };
}

async function main(): Promise<void> {
  if (process.env.SCRIPTC_RUN_BUN_ENV === "1") {
    const child = Bun.spawn(["missing-scriptc-test-command"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: await runtimeEnvironment(),
    });
    console.log(await child.exited);
  }
  console.log("ok");
}

main();
