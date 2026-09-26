import { spawn } from "node:child_process";

const child = spawn("node", ["-e", "setTimeout(()=>{},25)"], { stdio: ["pipe", "ignore", "ignore"] });
const input = child.stdin;
if (input === null) throw new Error("missing pipe");

input.on("finish", () => { console.log("finish"); });
input.on("error", (err) => { console.log("error", err.message); });
console.log("before", input.writable);
input.destroy();
console.log("after", input.writable);
child.on("exit", (code) => { console.log("exit", code); });
