// @rust-only
// @no-engine
// @exit: 2
// Listeners see the inherited code, and their writes determine the OS status.
import process from "node:process";
process.exitCode = 4;
process.on("exit", (code: number) => {
  console.log("exit", code, String(process.exitCode));
  process.exitCode = 2;
});
process.exit();
