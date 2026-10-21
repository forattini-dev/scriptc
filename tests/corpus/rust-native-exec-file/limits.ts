// @rust-only
// @no-engine
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const helper = process.env.SCRIPTC_EXEC_FILE_HELPER;
if (helper === undefined) throw new Error("missing native helper");
const run = promisify(execFile);
const slow = run(helper, ["slow"], { timeout: 50, windowsHide: true });
slow.then(undefined, (error: any) => {
  console.log("timeout", error.code === null, error.signal === "SIGTERM", error.killed === true, slow.child.killed);
  run(helper, ["large"], { maxBuffer: 8 }).then(undefined, (large: any) => {
    console.log("buffer", large instanceof RangeError, large.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", large.stdout.length === 8);
  });
});
