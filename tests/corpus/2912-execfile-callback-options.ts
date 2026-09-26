// The inline utf8/maxBuffer callback shape preserves concurrent execution,
// streams and error-first result on both successful and failed children.
import { execFile } from "node:child_process";

const child = execFile(
  "/bin/sh",
  ["-c", "printf out; printf note >&2"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  (error: Error | null, stdout, stderr) => {
    console.log("ok", error === null, JSON.stringify(stdout), JSON.stringify(stderr));
    execFile(
      "/bin/sh",
      ["-c", "printf partial; printf failed >&2; exit 3"],
      { encoding: "utf8", maxBuffer: 67108864 },
      (failed: Error | null, failedOut, failedErr) => {
        console.log("failed", failed !== null, JSON.stringify(failedOut), JSON.stringify(failedErr));
        console.log("error", failed === null ? "" : failed.message.includes("exit 3"));
      },
    );
  },
);
console.log("returned", child.pid !== undefined);
console.log("scheduled");
