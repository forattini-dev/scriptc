// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />
const executable = process.env.SCRIPTC_EXEC_FILE_HELPER ?? "";
const child = Bun.spawn([executable, "fail"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
const exited = child.exited;
const alias = child;
console.log("spawned", exited === child.exited, exited === alias.exited);
exited.then((code) => { console.log("exit", code); });
