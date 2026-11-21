// @rust-only
// @target bun
// @no-engine
/// <reference path="../rust-bun-spawn/node_modules/bun-types/index.d.ts" />
/// <reference types="node" />
const executable = process.env.SCRIPTC_EXEC_FILE_HELPER ?? "";
const child = Bun.spawn([executable, "ok"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
const text = new Response(child.stdout).text();
try { new Response(child.stdout).text(); }
catch (error) { console.log("locked", (error as Error).name, (error as Error).message); }
text.then((value) => { console.log("text", value.trim()); });
