// @exit: 2
// The implicit process exit status is set by the last numeric assignment.
process.exitCode = 7;
console.log("status set");
process.exitCode = 2;
