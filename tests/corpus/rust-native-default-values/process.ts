// @rust-only
// @no-engine
import proc from "node:process";
function stdin(value: boolean | undefined = process.stdin.isTTY): string { return typeof value; }
const stdout = (value: boolean | undefined = proc.stdout.isTTY): string => typeof value;
function stderr(value: boolean | undefined = proc.stderr.isTTY): string { return typeof value; }
function mode(value: boolean | undefined = process.stdin.isTTY): string {
  if (value === undefined) return "pipe";
  return value ? "terminal" : "false";
}
console.log("streams", stdin(), stdout(), stderr());
console.log("supplied", stdin(false), stdout(true), stderr(false));
console.log("mode", mode(), mode(false));
function redeclared(value: boolean | undefined = process.stdin.isTTY): string {
  var value: boolean | undefined;
  return typeof value;
}
console.log("redeclared", redeclared(), redeclared(false));
