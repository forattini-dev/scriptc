async function first(): Promise<string> {
  const value = (await import("./dynamic-lazy-fail-lib.ts")).value;
  return value();
}
async function second(): Promise<string> {
  const value = (await import("./dynamic-lazy-fail-lib.ts")).value;
  return value();
}
void first().then((value) => console.log(value), (reason) => console.log(reason === "failed"));
void second().then((value) => console.log(value), (reason) => console.log(reason === "failed"));
console.log("sync");
