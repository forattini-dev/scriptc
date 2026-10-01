// @rust-only
// @no-engine
// Explicit exit validates before marking the process as exiting or firing listeners.
process.exitCode = 7;
process.on("exit", (code: number) => {
  console.log("exit", code, String(process.exitCode));
});
for (const code of [1.5, NaN, Infinity, -Infinity, 2 ** 53]) {
  try {
    process.exit(code);
  } catch (error) {
    if (error instanceof RangeError) {
      console.log(error.name, (error as NodeJS.ErrnoException).code, error.message);
    }
  }
  console.log("preserved", String(process.exitCode));
}
// An explicit zero overrides the earlier seven and is visible to listeners.
process.exit(0);
