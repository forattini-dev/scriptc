// @rust-only
// @no-engine
async function main(): Promise<void> {
  const path = await import("node:path");
  console.log("dynamic builtin", path.basename(path.join("alpha", "beta.txt")));
}
main();
