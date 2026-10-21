// @rust-only
// @no-engine
import { execFile } from "node:child_process";
const helper = process.env.SCRIPTC_EXEC_FILE_HELPER;
if (helper === undefined) throw new Error("missing native helper");
let phase = "before";
const child = execFile(helper, ["ok"], (error: any, stdout: string, stderr: string): void => {
  console.log("callback", error === null, stdout === "stdout-value\n", stderr === "stderr-value\n", phase);
  console.log("exit", child.exitCode === 0, child.killed);
});
phase = "after";
console.log("scheduled", child === child);
