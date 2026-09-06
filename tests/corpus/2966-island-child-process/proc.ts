// The island module (Proxy keeps it there): child processes the way
// Effect's command executor and the shell utilities drive them — spawn
// with piped stdio, exec, a missing binary, stdin, kill, the sync forms.
import { spawn, exec, execFile, spawnSync, execSync, execFileSync } from "node:child_process";

const guard = new Proxy({ on: true }, {});

const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf8");

export function piped(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", "echo out; echo err 1>&2; exit 3"]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const events: string[] = [];
    child.on("spawn", () => events.push("spawn"));
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.stderr!.on("data", (c: Buffer) => err.push(c));
    child.on("exit", (code, signal) => events.push(`exit ${code} ${signal}`));
    child.on("close", (code, signal) => {
      events.push(`close ${code} ${signal}`);
      resolve(`${events.join(",")} out=${JSON.stringify(text(out))} err=${JSON.stringify(text(err))} pid=${typeof child.pid} exitCode=${child.exitCode}`);
    });
  });
}

export function viaExec(): Promise<string> {
  return new Promise((resolve) => {
    exec("echo hello from exec", (error, stdout, stderr) => {
      resolve(`${error} ${JSON.stringify(stdout)} ${JSON.stringify(stderr)}`);
    });
  });
}

export function execFailure(): Promise<string> {
  return new Promise((resolve) => {
    exec("echo bad 1>&2; exit 2", (error, stdout) => {
      resolve(`${error?.code} ${JSON.stringify(error?.message)} ${JSON.stringify(stdout)}`);
    });
  });
}

export function missing(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("definitely-not-a-binary-scriptc", ["x"]);
    child.on("error", (e: NodeJS.ErrnoException) => {
      resolve(`${e.code} ${e.errno} ${e.syscall} ${e.path} ${e.message}`);
    });
  });
}

export function stdinRoundTrip(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("cat");
    const out: Buffer[] = [];
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.on("close", (code) => resolve(`${code} ${JSON.stringify(text(out))}`));
    child.stdin!.write("abc ");
    child.stdin!.end("def\n");
  });
}

export function killed(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("sleep", ["5"]);
    child.on("exit", (code, signal) => resolve(`${code} ${signal} ${child.killed}`));
    child.on("spawn", () => {
      child.kill("SIGTERM");
    });
  });
}

export function withCwdAndEnv(): Promise<string> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", "pwd; echo $SCRIPTC_CHILD"], { cwd: "/", env: { ...process.env, SCRIPTC_CHILD: "yes" } }, (error, stdout) => {
      resolve(`${error} ${JSON.stringify(stdout)}`);
    });
  });
}

export function sync(): string {
  const r = spawnSync("sh", ["-c", "echo sync out; echo sync err 1>&2; exit 4"], { encoding: "utf8" });
  const ok = execSync("echo via execSync", { encoding: "utf8" });
  const file = execFileSync("sh", ["-c", "echo $SCRIPTC_SYNC"], { env: { ...process.env, SCRIPTC_SYNC: "env-ok" }, encoding: "utf8" });
  let failed = "";
  try {
    execSync("exit 7", { stdio: "pipe" });
  } catch (e) {
    failed = String((e as { status: number }).status);
  }
  return `${r.status} ${r.signal} ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)} | ${JSON.stringify(ok)} | ${JSON.stringify(file)} | ${failed}${(guard as { on: boolean }).on ? "" : "?"}`;
}
