// A shell command line is interpreted by the platform shell instead of
// being treated as one executable path.
import { spawn } from "node:child_process";

const child = spawn("exit 7", { shell: true, stdio: "ignore" });
child.once("exit", (code, signal) => {
  console.log("exit", code, signal);
});
child.once("close", (code, signal) => {
  console.log("close", code, signal);
});
console.log("spawned");
