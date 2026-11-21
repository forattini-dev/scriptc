// @rust-only
// @no-engine
async function main() {
  console.log("before dynamic cjs");
  const { value } = await import("./dependency.cjs");
  console.log("named", value);
  const { default: namespace } = await import("./dependency.cjs");
  console.log("default", namespace.value);
}

await main();
