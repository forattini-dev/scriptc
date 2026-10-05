// The entry project: its own @types/node is the real old-layout 24.13.3
// (app/node_modules, linked from tests/fixtures/node-types at test time).
// Reaching ../lib pulls lib/tsconfig.json, whose `types: ["node"]`
// resolves lib's own real new-layout 26.1.2: the newest copy is the one
// the program carries, and this project's 24.13.3 stands down.
// Listener registration on ChildProcess and net.Server is exactly the
// surface the two layouts declare through opposite module directions.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { label } from "../lib/src/label.ts";

console.log(label("start"));

const server = createServer((socket) => {
  socket.end();
});
server.on("listening", () => {
  console.log("listening");
  server.close();
});
server.once("close", () => {
  console.log("server closed");
});
server.listen(0, "127.0.0.1");

const child = spawn("/bin/sh", ["-c", "exit 3"], { stdio: "ignore" });
child.once("error", (err) => {
  console.log("child error", err.message);
});
child.on("exit", (code, signal) => {
  console.log("child exit", code ?? -1, signal ?? "none");
});
