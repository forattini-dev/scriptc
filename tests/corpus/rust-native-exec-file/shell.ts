// @rust-only
// @no-engine
import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);
const command = process.platform === "win32"
  ? "echo shell-out&& echo shell-err 1>&2"
  : "printf shell-out; printf shell-err >&2";
const failing = process.platform === "win32"
  ? "echo failed-out&& echo failed-err 1>&2&& exit /b 7"
  : "printf failed-out; printf failed-err >&2; exit 7";
run(command).then(success => {
  console.log(
    "capture",
    success.stdout.trim() === "shell-out",
    success.stderr.trim() === "shell-err",
  );
  return run(failing).then(undefined, (error: any) => {
    console.log(
      "failure",
      error.code === 7,
      error.stdout.trim() === "failed-out",
      error.stderr.trim() === "failed-err",
      error.cmd === failing,
    );
  });
});
