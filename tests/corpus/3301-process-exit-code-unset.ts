// @rust-only
// @no-engine
import process from "node:process";

console.log(String(process.exitCode));
process.on("exit", (code: number) => {
  console.log("exit", code, String(process.exitCode));
});
