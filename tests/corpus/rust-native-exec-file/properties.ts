// @rust-only
// @no-engine
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const helper = process.env.SCRIPTC_EXEC_FILE_HELPER;
if (helper === undefined) throw new Error("missing native helper");
const run = promisify(execFile);
const pending = run(helper, ["ok"]);
const child: any = pending.child;
const keys = Object.keys(pending);
console.log("properties", keys.length === 1, keys[0] === "child", Object.hasOwn(pending, "child"));
console.log("child", typeof child.pid === "number", child.exitCode === null, child.killed === false);
const next = pending.then(result => {
  console.log("settled", result.stdout === "stdout-value\n", child.exitCode === 0, child.killed === false);
});
console.log("new-promise", Object.hasOwn(next, "child"), Object.keys(next).length === 0);
