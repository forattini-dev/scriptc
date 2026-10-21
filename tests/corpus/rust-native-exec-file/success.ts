// @rust-only
// @no-engine
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const helper = process.env.SCRIPTC_EXEC_FILE_HELPER;
if (helper === undefined) throw new Error("missing native helper");
const run = promisify(execFile);
const promise = run(helper, ["ok"], { windowsHide: true });
const erased: any = promise;
console.log("identity", promise.child === promise.child, erased.child === promise.child);
let phase = "before";
promise.then(result => {
  console.log("output", result.stdout === "stdout-value\n", result.stderr === "stderr-value\n", phase);
  console.log("exit", promise.child.exitCode === 0, promise.child.killed);
});
phase = "after";
console.log("scheduled");
