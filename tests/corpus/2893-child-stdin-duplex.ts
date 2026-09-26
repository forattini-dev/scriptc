import { spawn } from "node:child_process";

const child = spawn("node", ["-e", "process.stdin.on('data', b => process.stdout.write(b));"]);
const input = child.stdin;
const output = child.stdout;
const errors = child.stderr;
if (input === null || output === null || errors === null) throw new Error("missing pipe");

let echoed = "";
output.on("data", (chunk) => { echoed += chunk.toString(); });
output.on("end", () => { console.log("echo", JSON.stringify(echoed)); });
errors.on("data", (chunk) => { process.stderr.write(chunk); });
input.on("finish", () => { console.log("finish", input.writable); });
input.on("error", (err) => { console.log("error", err.message); });
console.log("initial", input.writable);
console.log("writes", input.write("hé"), input.write(new Uint8Array([108, 108, 111, 10])));
input.end();
console.log("ended", input.writable);
child.on("exit", (code) => { console.log("exit", code); });
