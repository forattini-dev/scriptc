// @rust-only
// @no-engine
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const helper = process.env.SCRIPTC_EXEC_FILE_HELPER;
if (helper === undefined) throw new Error("missing native helper");
const run = promisify(execFile);
run(helper, ["env"], {env: {SCRIPTC_EXEC_TEST_VALUE: "native-value"}, windowsHide: true}).then(result => {
  console.log("environment", result.stdout === "native-value", result.stderr === "");
  run(helper, ["cwd"], {cwd: process.cwd()}).then(directory => {
    console.log("directory", directory.stdout === process.cwd(), directory.stderr === "");
  });
});
