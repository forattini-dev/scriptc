// @rust-only
// @no-engine
import { spawn } from "node:child_process";

const child = spawn("sh", ["-c", "sleep 0.05; wc -c"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const input = child.stdin;
const output = child.stdout;
if (input === null || output === null) throw new Error("missing pipe");

let count = "";
output.on("data", (chunk) => { count += chunk.toString(); });
output.on("end", () => { console.log("count", count.trim()); });
input.on("drain", () => { console.log("unexpected drain"); });
input.on("finish", () => { console.log("finish", input.writable); });
input.on("error", (error) => { console.log("error", error.message); });
console.log("write", input.write(Buffer.alloc(1024 * 1024, 65)));
console.log("tail", input.write("ação🎯"));
input.end();
console.log("ended", input.writable);
child.on("exit", (code) => { console.log("exit", code); });
