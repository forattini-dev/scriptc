import { spawn } from "node:child_process";

async function main(): Promise<void> {
const command = process.platform === "win32" ? "cmd.exe" : "sh";
const args = process.platform === "win32"
  ? ["/d", "/c", "more > nul"]
  : ["-c", "cat >/dev/null"];
const child = spawn(command, args, { stdio: ["pipe", "ignore", "inherit"] });

await new Promise<void>((resolve, reject) => {
  child.stdin.write(Buffer.from("hello"), (error) => {
    if (error) reject(error);
    else resolve();
  });
});
child.stdin?.end();
await new Promise<void>((resolve) => child.on("close", () => resolve()));
console.log("done");
}

void main();
