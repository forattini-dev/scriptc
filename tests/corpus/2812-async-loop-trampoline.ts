// The await keeps this loop in the suspended async state-machine subset, but
// its branch is never taken. Advancing an iteration must remain stackless
// without changing the synchronous prefix of an async function.
async function count(): Promise<number> {
  let value = 0;
  while (value < 50_000) {
    if (value < 0) await Promise.resolve();
    value += 1;
  }
  return value;
}

console.log("before");
const result = count();
console.log("after-call");
console.log(await result);
