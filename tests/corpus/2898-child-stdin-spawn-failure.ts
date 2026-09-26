import { spawn } from "node:child_process";

const child = spawn("definitely-not-a-binary-child-stdin", []);
const input = child.stdin;
if (input === null) throw new Error("missing default stdin pipe");

console.log("initial", input.writable);
child.on("error", (err) => {
  console.log("error", (err as NodeJS.ErrnoException).code, input.writable);
});
