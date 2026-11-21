// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />
async function run(): Promise<number> {
  const child = Bun.spawn([process.env.SCRIPTC_EXEC_FILE_HELPER ?? "", "fail"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  const alias = child;
  console.log("identity", alias.exited === child.exited);
  const same = (left: typeof child | undefined, right: typeof child | undefined) => left === right;
  console.log("child", same(alias, child), same(alias, undefined));
  return await alias.exited;
}
run().then((code) => console.log("exit", code));
