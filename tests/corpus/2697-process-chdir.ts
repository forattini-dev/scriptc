// process.chdir() updates process-wide cwd state and reports filesystem
// failures as catchable Node-style errors. The Node and native lanes start
// in the same repository root, so the relative transition is deterministic.
const original = process.cwd();
process.chdir("tests/corpus");
console.log(process.cwd().endsWith("tests/corpus"));
process.chdir(original);
console.log(process.cwd() === original);

try {
  process.chdir("scriptc-process-chdir-definitely-missing");
} catch (error) {
  if (error instanceof Error) {
    console.log(error.name, (error as NodeJS.ErrnoException).code);
  }
}
