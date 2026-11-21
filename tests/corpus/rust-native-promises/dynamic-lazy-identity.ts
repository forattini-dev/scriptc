let saved: (() => string) | undefined;
async function first(): Promise<void> {
  const value = (await import("./dynamic-lazy-lib.ts")).value;
  saved = value;
}
async function second(): Promise<void> {
  const value = (await import("./dynamic-lazy-lib.ts")).value;
  console.log(value === saved);
}
void first();
void second();
