// ChildProcess.once() is the terminal-listener shape used by real CLIs.
// The listener receives Node's number | null exit-code contract.
import { spawn } from "node:child_process";

const child = spawn("node", ["-e", "process.exit(6)"], { stdio: "ignore" });
child.once("exit", (code) => {
  console.log("once exit", code);
});
console.log("spawned");
