// A non-integer assignment throws catchably and leaves the exit code alone.
try {
  process.exitCode = 1.5;
} catch (error) {
  if (error instanceof RangeError) console.log(error.message);
}
try {
  process.exitCode = 2 ** 53;
} catch (error) {
  if (error instanceof RangeError) console.log(error.message);
}
console.log("continued");
