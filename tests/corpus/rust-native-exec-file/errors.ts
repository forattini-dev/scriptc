// @rust-only
// @no-engine
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const helper = process.env.SCRIPTC_EXEC_FILE_HELPER;
if (helper === undefined) throw new Error("missing native helper");
const run = promisify(execFile);
run(helper, ["fail"]).then(undefined, (error: any) => {
  console.log("failure", error instanceof Error, error.code === 7, error.signal === null, error.killed === false);
  console.log("captured", error.stdout === "partial\n", error.stderr === "diagnostic\n");
  run("scriptc-missing-exec-file-fixture-command").then(undefined, (missing: any) => {
    console.log("missing", missing instanceof Error, missing.code === "ENOENT", missing.stdout === "", missing.stderr === "");
  });
});
