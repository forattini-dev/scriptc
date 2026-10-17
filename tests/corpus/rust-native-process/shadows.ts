// @rust-only
// @no-engine
function local(process: { stdout: { isTTY: boolean }; env: { NO_COLOR: string } }): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}
console.log("shadow", local({ stdout: { isTTY: true }, env: { NO_COLOR: "" } }), local({ stdout: { isTTY: false }, env: { NO_COLOR: "1" } }));
function stringTruth(value: string): boolean { return !value; }
function numberTruth(value: number): boolean { return !value; }
function unitTruth(value: null | undefined): boolean { return !value; }
console.log("primitive truth", stringTruth(""), stringTruth("x"), numberTruth(0), numberTruth(-0), numberTruth(0 / 0), unitTruth(null), unitTruth(undefined));
console.log("numeric negation", !1, numberTruth(1));
