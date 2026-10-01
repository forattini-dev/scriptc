// @rust-only
// @no-engine
// @exit: 3
// Explicit exit publishes the int32 code before listeners and respects their writes.
process.exitCode = 7;
process.on("exit", (code: number) => {
  console.log("exit", code, String(process.exitCode));
  process.exitCode = 3;
});
process.exit(2 ** 32 + 1);
