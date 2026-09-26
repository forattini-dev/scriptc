// @exit: 7
// Node converts a safe integer to signed int32 before notifying listeners.
process.on("exit", (code: number) => console.log("listener", code));
process.exitCode = 2 ** 31;
process.exitCode = 2 ** 32 + 7;
