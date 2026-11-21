async function load(): Promise<string> {
  return (await import("./dynamic-lazy-lib.ts")).value();
}
void load();
