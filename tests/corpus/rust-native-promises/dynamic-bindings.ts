async function load(): Promise<void> {
  const step = (await import("./dynamic-bindings-lib.ts")).step;
  console.log(step());
  console.log(step());
}
void load();
console.log("entry");
