async function load(): Promise<void> {
  const label = (await import("./dynamic-const-lib.ts")).label;
  console.log(label);
}
void load();
void load();
console.log("sync");
