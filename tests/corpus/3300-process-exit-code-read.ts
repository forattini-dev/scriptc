// @rust-only
// @no-engine
// @exit: 7
// Keep the public value distinct from the status returned to the OS.
console.log(String(process.exitCode));
console.log(process.exitCode === undefined);
process.exitCode = 0;
console.log(String(process.exitCode));
console.log(process.exitCode === undefined);
process.exitCode = 4294967297;
console.log(String(process.exitCode));
process.exitCode = -1;
console.log(String(process.exitCode));
process.exitCode = 7;
console.log(String(process.exitCode));
