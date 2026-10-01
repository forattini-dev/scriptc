// @rust-only
// @no-engine
// @exit: 7
// Invalid numeric writes preserve the last valid code and throw Node errors.
process.exitCode = 7;
function setCode(code: number): void {
  process.exitCode = code;
}
for (const code of [1.5, -1.5, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), 1e21]) {
  try {
    setCode(code);
    console.log("accepted", code);
  } catch (error) {
    if (error instanceof RangeError) {
      console.log(error.name, (error as NodeJS.ErrnoException).code, error.message);
    }
  }
  console.log("preserved", String(process.exitCode));
}
process.exitCode = Number.MAX_SAFE_INTEGER;
console.log("maximum", String(process.exitCode));
process.exitCode = Number.MIN_SAFE_INTEGER;
console.log("minimum", String(process.exitCode));
process.exitCode = -0;
console.log("negative zero", String(process.exitCode));
process.exitCode = 7;
