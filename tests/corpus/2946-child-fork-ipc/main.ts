import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));
const child = fork(worker, ["alpha", "two words"], {
  cwd: import.meta.dirname,
  env: { IPC_FIXTURE: "yes" },
  execArgv: [],
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});

let sendCallbackDone = false;
let closedCallbackMessage = "pending";
let exitCode: number | null = null;
console.log("parent connected", child.connected);

child.once("message", (message: {
  argv: string[];
  connected: boolean;
  cwd: boolean;
  env: string | undefined;
  kind: string;
  value: number;
}) => {
  console.log("reply", JSON.stringify(message));
});

child.once("disconnect", () => {
  const late = child.send({ kind: "late", value: 0 }, (error) => {
    closedCallbackMessage = error?.message ?? "none";
    if (exitCode !== null) console.log("closed", closedCallbackMessage, exitCode);
  });
  console.log("disconnect", child.connected, sendCallbackDone, late);
});

child.once("exit", (code) => {
  exitCode = code;
  if (closedCallbackMessage !== "pending") console.log("closed", closedCallbackMessage, code);
});

child.send({ kind: "ping", value: 42 }, (error) => {
  if (error) throw error;
  sendCallbackDone = true;
});
