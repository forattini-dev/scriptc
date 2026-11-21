// @rust-only
// @no-engine
try {
  process.kill(process.pid, "NOT_A_SIGNAL" as NodeJS.Signals);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message.includes("Unknown signal"));
}
