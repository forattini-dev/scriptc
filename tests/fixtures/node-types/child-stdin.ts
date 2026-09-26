import { spawn } from "node:child_process";

const child = spawn("node", ["-e", "process.stdin.pipe(process.stdout)"]);
let text = "";
child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
child.stdout.on("end", () => { console.log(text); });
child.stdin.write("typed child stdin");
child.stdin.end();
