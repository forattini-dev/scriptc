// ChildProcess joins the checked-dynamic native-handle bridge: passing it
// through `unknown` and through an undefined-armed union preserves the one
// live handle and all later lifecycle observations.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

function throughUnknown(value: unknown): unknown {
  return value;
}

function optional(value: ChildProcess | undefined): unknown {
  return value;
}

const child = spawn("/bin/sh", ["-c", "exit 4"], { stdio: "ignore" });
const recovered = throughUnknown(child) as ChildProcess;
const optionalChild = optional(recovered) as ChildProcess | undefined;

console.log("same child:", recovered === child, optionalChild === child);
console.log("running:", (recovered.pid ?? 0) > 0, recovered.exitCode, recovered.killed);

if (optionalChild) {
  optionalChild.on("exit", (code) => {
    console.log("exit:", code, optionalChild.exitCode, optionalChild.killed);
  });
}

console.log("missing:", optional(undefined) === undefined);
