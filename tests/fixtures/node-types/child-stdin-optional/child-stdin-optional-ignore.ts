import { spawn, type ChildProcess } from "node:child_process";

async function main(): Promise<void> {
  const command = process.platform === "win32" ? "cmd.exe" : "sh";
  const args = process.platform === "win32" ? ["/d", "/c", "exit", "/b", "0"] : ["-c", "exit 0"];
  const child: ChildProcess = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"] });
  child.stdin?.end();
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  console.log("done");
}

void main();
