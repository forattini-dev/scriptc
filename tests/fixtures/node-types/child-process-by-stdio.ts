import { spawn } from "node:child_process";

const child = spawn("node", ["-e", "process.exit(6)"], {
  stdio: ["ignore", "pipe", "pipe"],
});

console.log("streams", child.stdout !== null, child.stderr !== null);
child.once("exit", (code, signal) => {
  console.log("exit", code, signal);
});
child.once("close", (code, signal) => {
  console.log("close", code, signal);
});
