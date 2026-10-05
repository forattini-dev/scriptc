// off(): declared by both layouts on ChildProcess and net.Server. With one
// copy of @types/node in the program the call typechecks; the lowering's
// verdict on the member is pinned by the harness (the Rust lane's current
// answer).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { label } from "../lib/src/label.ts";

console.log(label("off"));
const server = createServer((socket) => {
  socket.end();
});
const onError = (err: Error): void => {
  console.log("server error", err.message);
};
server.on("error", onError);
server.off("error", onError);

const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
const onExit = (code: number | null): void => {
  console.log("child exit", code ?? -1);
};
child.on("exit", onExit);
child.off("exit", onExit);
console.log("done");
