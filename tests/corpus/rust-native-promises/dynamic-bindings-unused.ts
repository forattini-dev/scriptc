async function neverCalled(): Promise<void> {
  const step = (await import("./dynamic-bindings-lib.ts")).step;
  console.log(step());
}
void neverCalled;
console.log("entry only");
