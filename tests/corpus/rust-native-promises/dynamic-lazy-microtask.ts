async function load(): Promise<void> {
  const value = (await import("./dynamic-lazy-microtask-lib.ts")).value;
  console.log(value());
}
void load();
void Promise.resolve(0).then(() => console.log("entry microtask"));
console.log("sync");
