// Static self-import: import() of the ENTRY module answers the entry's own
// exports (no re-evaluation — the module is already running); the
// namespace resolves after the entry's synchronous body, like Node.
export function tag(): string { return "self"; }
export const version = 7;
async function main(): Promise<void> {
  const ns = await import("./2052-dynamic-import-self.ts");
  console.log(ns.tag(), ns.version);
}
main();
console.log("entry body done");
