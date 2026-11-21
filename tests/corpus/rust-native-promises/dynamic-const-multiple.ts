async function first(): Promise<void> {
  const label = (await import("./dynamic-const-lib.ts")).label;
  console.log(label);
}
async function second(): Promise<void> {
  const count = (await import("./dynamic-const-lib.ts")).count;
  console.log(count);
}
void first();
void second();
console.log("sync");
