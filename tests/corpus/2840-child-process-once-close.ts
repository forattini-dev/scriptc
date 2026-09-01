// ChildProcess close is distinct from exit and follows it after stdio closes.
import { spawn } from "node:child_process";

const child = spawn("node", ["-e", "process.exit(7)"], { stdio: "ignore" });
child.once("exit", (code, signal) => {
  console.log("exit", code, signal);
});
child.once("close", (code, signal) => {
  console.log("close", code, signal);
  const reversed = spawn("node", ["-e", "process.exit(8)"], { stdio: "ignore" });
  // Event identity, not listener registration order, determines that exit
  // precedes close.
  reversed.once("close", (nextCode) => {
    console.log("reversed close", nextCode);
  });
  reversed.once("exit", (nextCode) => {
    console.log("reversed exit", nextCode);
  });
});
console.log("spawned");
