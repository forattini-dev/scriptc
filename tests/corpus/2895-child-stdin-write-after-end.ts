import { spawn } from "node:child_process";

const child = spawn("node", ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
const input = child.stdin;
if (input === null) throw new Error("missing pipe");

input.on("finish", () => { console.log("finish"); });
input.on("error", (err) => { console.log("error", (err as NodeJS.ErrnoException).code, err.message, input.writable); });
input.end();
console.log("write", input.write("x"), input.writable);
child.on("exit", (code) => { console.log("exit", code); });
