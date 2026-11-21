// @rust-only
// @no-engine
// @npm-static: auto
async function main() {
  const { marker } = await import("dynamic-runtime-export");
  console.log("dynamic package", marker);
}

await main();
