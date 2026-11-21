async function change(): Promise<void> {
  const shared = (await import("./dynamic-object-lib.ts")).shared;
  shared.value = 7;
}
async function report(): Promise<void> {
  const read = (await import("./dynamic-object-lib.ts")).read;
  console.log(read());
}
void change();
void report();
console.log("entry");
