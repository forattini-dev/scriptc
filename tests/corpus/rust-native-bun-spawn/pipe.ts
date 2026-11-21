// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />
const executable = process.env.SCRIPTC_EXEC_FILE_HELPER ?? "";
const child = Bun.spawn([executable, "ok"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
new Response(child.stdout).text().then((text) => { console.log("text", text.trim()); });
