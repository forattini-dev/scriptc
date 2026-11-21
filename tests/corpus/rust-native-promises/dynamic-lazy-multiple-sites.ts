async function first(): Promise<void> {
  const value = (await import("./dynamic-lazy-lib.ts")).value;
  console.log(value());
}
async function second(): Promise<void> {
  const other = (await import("./dynamic-lazy-lib.ts")).other;
  console.log(other());
}
void first();
void second();
console.log("sync");
