// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />
const executable = process.env.SCRIPTC_EXEC_FILE_HELPER ?? "";
async function readOutput(): Promise<string> {
  const child = Bun.spawn([executable, "ok"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return (await new Response(child.stdout).text()).toUpperCase();
}
readOutput().then((value) => { console.log("awaited", value.trim()); });
