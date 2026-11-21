async function load(): Promise<void> {
  const label = (await import("./dynamic-const-lib.ts")).label;
  console.log(label);
}
void load();
console.log("early importer");
export function marker(): void {}
