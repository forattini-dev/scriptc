import { spawn, type ChildProcess } from "node:child_process";

async function main(): Promise<void> {
  const command = process.platform === "win32" ? "cmd.exe" : "sh";
  const args = process.platform === "win32" ? ["/d", "/c", "exit", "/b", "0"] : ["-c", "exit 0"];
  const child: ChildProcess = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"] });
  try {
    child.stdin.end();
    console.log("no error");
  } catch (error) {
    console.log(error instanceof TypeError ? "TypeError" : "other");
  }
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
}

void main();
