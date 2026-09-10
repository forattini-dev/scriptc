// The native callback's promise becomes an engine promise. Only the
// engine can know whether the package observes the returned promise.
import { fire } from "rejectionzoo";

const mode = process.argv[2] ?? "orphan";
async function reject(): Promise<void> {
  if (mode === "orphan" || mode === "multiple-pending" || mode === "primitive") {
    await new Promise<void>((resolve) => { setTimeout(resolve, 1); });
  }
  if (mode === "primitive" || mode === "caught-string") throw "plain reason";
  if (mode === "caught-number") throw 42;
  if (mode === "caught-bool") throw false;
  throw new RangeError("native orphan");
}
async function staticFail(): Promise<void> { throw new Error("static first"); }
if (mode === "mixed") staticFail();
fire(reject, mode);
console.log("armed");
