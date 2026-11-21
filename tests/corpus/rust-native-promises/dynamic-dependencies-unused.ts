async function neverCalled(): Promise<void> {
  const read = (await import("./dynamic-dependency-left.ts")).read;
  console.log(read());
}
void neverCalled;
console.log("entry only");
