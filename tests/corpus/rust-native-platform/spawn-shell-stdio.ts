import { spawn } from "node:child_process";

const child = spawn("echo scriptc-shell", {
  shell: true,
  stdio: ["inherit", "pipe", "pipe"],
});
let output = "";
child.stdout?.setEncoding("utf8");
child.stdout?.on("data", (chunk) => {
  output += chunk;
});
child.on("close", (code) => {
  console.log(code, output.trim());
});
