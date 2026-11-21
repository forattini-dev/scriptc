async function neverCalled(): Promise<void> {
  const label = (await import("./dynamic-const-lib.ts")).label;
  console.log(label);
}
void neverCalled;
console.log("entry only");
