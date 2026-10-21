// @rust-only
// @no-engine
import { execFile } from "node:child_process";
const helper = process.env.SCRIPTC_EXEC_FILE_HELPER;
if (helper === undefined) throw new Error("missing native helper");
execFile(helper, ["fail"], (error: any, stdout: string, stderr: string): void => {
  console.log("callback-error", error instanceof Error, error.code === 7, error.killed === false, error.signal === null);
  console.log("capture", stdout === "partial\n", stderr === "diagnostic\n", error.stdout === undefined, error.stderr === undefined);
});
