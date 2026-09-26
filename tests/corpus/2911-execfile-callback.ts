// child_process.execFile's asynchronous callback slice: the call returns a
// live ChildProcess immediately, captures utf8 stdout/stderr, fires after
// the current turn, and reports non-zero/spawn failures through Error.
import { execFile } from "node:child_process";
import * as childProcess from "node:child_process";

const child = execFile(
  "/bin/sh",
  ["-c", "printf out; printf err >&2"],
  (error, stdout, stderr) => {
    console.log("ok", error === null, JSON.stringify(stdout), JSON.stringify(stderr));
    execFile(
      "/bin/sh",
      ["-c", "printf partial; printf failed >&2; exit 3"],
      (failed, failedOut, failedErr) => {
        console.log("fail", failed !== null, JSON.stringify(failedOut), JSON.stringify(failedErr));
        console.log("fail-message", JSON.stringify(failed === null ? "" : failed.message));
        execFile("definitely-not-a-scriptc-binary", (missing) => {
          console.log("missing", missing !== null, JSON.stringify(missing === null ? "" : missing.message));
          execFile("true", () => {
            console.log("zero-parameter callback");
            childProcess.execFile("true", () => console.log("namespace callback"));
          });
        });
      },
    );
  },
);

console.log("returned", child.pid !== undefined, child.stdout !== null, child.stderr !== null);
console.log("scheduled");
