import { execFile, type ExecFileOptions } from "node:child_process";

export interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: NodeJS.Signals;
}

/** Observe a completed process, including signal termination. Spawn failures,
 * timeouts and output-limit errors remain harness failures. */
export function runToExit(
  file: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  stdin = "",
  limits: Pick<ExecFileOptions, "timeout" | "maxBuffer"> = {},
): Promise<ProcessOutcome> {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(file, args, { ...limits, encoding: "utf8", env }, (error, stdout, stderr) => {
      const signal = error?.code === null && !error.killed ? error.signal : undefined;
      if (error && typeof error.code !== "number" && !signal) {
        rejectRun(error);
        return;
      }
      resolveRun({
        stdout,
        stderr,
        exitCode: error ? typeof error.code === "number" ? error.code : null : 0,
        ...(signal ? { signal } : {}),
      });
    });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") rejectRun(error);
    });
    child.stdin?.end(stdin);
  });
}
