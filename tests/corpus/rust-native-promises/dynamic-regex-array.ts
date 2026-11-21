async function first(): Promise<void> {
  const check = (await import("./dynamic-regex-array-lib.ts")).check;
  console.log(check());
}
async function second(): Promise<void> {
  const item = (await import("./dynamic-regex-array-lib.ts")).item;
  console.log(item());
}
void first();
void second();
console.log("entry");
