// @dynamic
// A failed module evaluation is cached by Node. Every later import must
// reject with that same failure; it must never expose a namespace whose
// bindings were left uninitialized by the failed evaluation.
async function main(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await import("brokenesm");
      console.log("loaded");
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
    }
  }
}

await main();
