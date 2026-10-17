// @rust-only
// @no-engine
console.log("tty", process.stdin.isTTY === true, process.stdout.isTTY === true, process.stderr.isTTY === true);
console.log("tty undefined", process.stdout.isTTY === undefined, process.stdout.isTTY === false);
console.log("environment", process.env.SCRIPTC_NATIVE_PROCESS_VALUE === "runtime-value", process.env["SCRIPTC_NATIVE_PROCESS_EMPTY"] === "", process.env.SCRIPTC_NATIVE_PROCESS_MISSING === undefined);
console.log("truthy", !process.env.SCRIPTC_NATIVE_PROCESS_EMPTY, !process.env.SCRIPTC_NATIVE_PROCESS_MISSING, !process.env.SCRIPTC_NATIVE_PROCESS_VALUE);
const useColor = process.stdout.isTTY === true && !process.env["NO_COLOR"];
console.log("colour", useColor);
