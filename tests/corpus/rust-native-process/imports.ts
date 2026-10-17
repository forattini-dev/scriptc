// @rust-only
// @no-engine
import proc, { env, stdout, stderr, stdin } from "node:process";
import * as namespace from "node:process";
console.log("imports", proc.stdout.isTTY === stdout.isTTY, namespace.stderr.isTTY === stderr.isTTY, proc.stdin.isTTY === stdin.isTTY);
console.log("env imports", env.SCRIPTC_NATIVE_PROCESS_VALUE === proc.env["SCRIPTC_NATIVE_PROCESS_VALUE"], namespace.env.SCRIPTC_NATIVE_PROCESS_EMPTY === "");
function key(): string { console.log("key once"); return "SCRIPTC_NATIVE_PROCESS_VALUE"; }
console.log("computed", env[key()] === "runtime-value");
