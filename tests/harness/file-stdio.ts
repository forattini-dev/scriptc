import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Capture finite, non-interactive differential programs with regular files.
 * This preserves stdout/stderr bytes without relying on asynchronous pipe
 * flushing, which is unavailable in some restricted execution environments. */
export async function runFileStdio(executable: string, args: readonly string[], env = process.env) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-file-stdio-"));
  try {
    const stdout = await open(join(dir, "stdout"), "wx", 0o600);
    try {
      const stderr = await open(join(dir, "stderr"), "wx", 0o600);
      try {
        const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          const child = spawn(executable, [...args], {
            env, stdio: ["ignore", stdout.fd, stderr.fd], timeout: 30_000,
          });
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        return {
          ...status,
          stdout: await readFile(join(dir, "stdout")),
          stderr: await readFile(join(dir, "stderr")),
        };
      } finally { await stderr.close(); }
    } finally { await stdout.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}
