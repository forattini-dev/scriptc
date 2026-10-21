// @rust-only
// @no-engine
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
let phase = "before";
try {
  run(undefined as any);
  console.log("unexpected");
} catch (error: any) {
  console.log("validation", error instanceof TypeError, error.code === "ERR_INVALID_ARG_TYPE", phase);
}
phase = "after";
console.log("continued", phase);
