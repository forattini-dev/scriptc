// The entry project: typed by the real old-layout @types/node 24.13.3
// (app/node_modules, linked from tests/fixtures/node-types at test time).
// Reaching ../lib pulls lib/tsconfig.json, whose `types: ["node"]`
// resolves lib's own new-layout copy — the copy that stands down.
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
