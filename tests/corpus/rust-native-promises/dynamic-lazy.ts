async function load(): Promise<void> {
  const value = (await import("./dynamic-lazy-lib.ts")).value;
  console.log(value());
}
void load();
void load();
void Promise.resolve(0).then(() => console.log("microtask"));
console.log("sync");
