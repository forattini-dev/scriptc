async function load(): Promise<void> {
  const value = (await import("./dynamic-lazy-lib.ts")).value;
  console.log(value());
}
void load();
console.log("early importer");
export function marker(): void {}
