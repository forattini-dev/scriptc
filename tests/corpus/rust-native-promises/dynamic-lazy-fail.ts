async function load(): Promise<string> {
  const value = (await import("./dynamic-lazy-fail-lib.ts")).value;
  return value();
}
void load().then((value) => console.log(value), (reason) => console.log(reason === "failed"));
void load().then((value) => console.log(value), (reason) => console.log(reason === "failed"));
console.log("sync");
