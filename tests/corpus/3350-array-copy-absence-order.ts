// @rust-only
// @no-engine
// Copying an absent slot stores present undefined, after evaluating the
// destination receiver/index and source receiver/index exactly once.
let trace = "";
const destination: string[] = ["old"];
const source: string[] = [" present "];
source.length = 2;

function target(): string[] {
  trace += "t";
  return destination;
}
function targetIndex(): number {
  trace += "i";
  return 0;
}
function origin(): string[] {
  trace += "s";
  return source;
}
function sourceIndex(index: number): number {
  trace += "j";
  return index;
}
function copy(index: number): void {
  trace = "";
  target()[targetIndex()] = (origin()[sourceIndex(index)]);
  console.log("copy", index, trace, 0 in destination);
  try {
    console.log("value", destination[0].trim());
  } catch (error) {
    console.log(error instanceof TypeError, (error as Error).message);
  }
}
copy(0);
copy(1);
copy(7);
copy(-1);
copy(0.5);
copy(Number.NaN);

function failingOrigin(): string[] {
  trace += "s";
  throw new Error("source failed");
}
trace = "";
try {
  target()[targetIndex()] = failingOrigin()[sourceIndex(0)];
} catch (error) {
  console.log("throw", trace, (error as Error).message);
}
