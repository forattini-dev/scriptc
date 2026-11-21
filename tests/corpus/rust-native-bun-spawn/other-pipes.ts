// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />
const executable = process.env.SCRIPTC_EXEC_FILE_HELPER ?? "";
const ignored = Bun.spawn([executable, "ok"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
new Response(ignored.stdout).text().then((value) => { console.log("empty", value === ""); });
const piped = Bun.spawn([executable, "ok"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
new Response(piped.stderr).text().then((value) => { console.log("stderr", value.trim()); });
