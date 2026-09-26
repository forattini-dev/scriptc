import { execFile } from "node:child_process";

execFile("/bin/sh", ["-c", "printf typed-execfile"], (error, stdout, stderr) => {
  if (error !== null) throw error;
  console.log(stdout, stderr === "");
});
