// @rust-only
// @no-engine
// Omitting the argument does not turn the unset property into explicit zero.
process.on("exit", (code: number) => {
  console.log("exit", code, String(process.exitCode));
});
process.exit();
