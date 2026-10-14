import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WindowsJobReceipt {
  state: "finished";
  pid: number;
  exitCode: number;
  processLimit: number;
  totalProcesses: number;
  activeAfterCleanup: number;
  descendantsCleaned: number;
  limitTerminations: number;
}

let discoveredPython: string | undefined;
export function windowsJobInvocation(command: string, args: string[], cache: string) {
  if (process.platform !== "win32") return { command, args, reportFile: undefined, verifyExit: (code: number): WindowsJobReceipt | undefined => { void code; return undefined; } };
  let python = process.env["SCRIPTC_RUST_WINDOWS_JOB_PYTHON"] ?? discoveredPython;
  if (!python) {
    try {
      python = execFileSync("mise", ["which", "python"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      discoveredPython = python;
    } catch {
      throw new Error("Windows Rust differential execution requires Python 3; set SCRIPTC_RUST_WINDOWS_JOB_PYTHON to its executable");
    }
  }
  const limit = Number(process.env["SCRIPTC_RUST_JOB_PROCESS_LIMIT"] ?? "32");
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error("Windows job process limit must be 1 through 128");
  const directory = join(cache, "windows-jobs");
  mkdirSync(directory, { recursive: true });
  const reportFile = join(directory, `${process.pid}-${randomUUID()}.json`);
  return {
    command: python,
    args: [join(import.meta.dirname, "windows-job.py"), reportFile, String(limit), command, ...args],
    reportFile,
    verifyExit(code: number): WindowsJobReceipt {
      const receipt = JSON.parse(readFileSync(reportFile, "utf8")) as WindowsJobReceipt;
      if (receipt.state !== "finished" || receipt.exitCode !== code || receipt.processLimit !== limit || receipt.activeAfterCleanup !== 0)
        throw new Error(`Windows job did not confirm an executed, cleaned-up child: ${JSON.stringify(receipt)}`);
      return receipt;
    },
  };
}
