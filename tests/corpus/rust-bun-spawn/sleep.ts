// @rust-only
// @target bun
// @no-engine
async function main(): Promise<void> {
  console.log("before");
  await Bun.sleep(0);
  console.log("after");
}

void main();
