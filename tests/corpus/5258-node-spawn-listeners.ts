/// <reference types="node" />
import { spawn } from "node:child_process";

async function exitCode(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(windows ? "cmd.exe" : "sh", windows
      ? ["/d", "/s", "/c", "exit 7"]
      : ["-c", "exit 7"], {
      env: process.env,
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  });
}

async function main(): Promise<void> {
  console.log(await exitCode());
}

main();
