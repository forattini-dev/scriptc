// @rust-only
// @no-engine
async function main(): Promise<void> {
  try {
    // The dependency is intentionally absent: optional imports reject.
    // @ts-ignore
    await import("scriptc-deliberately-missing-optional-package");
    console.log("unexpected");
  } catch {
    console.log("missing");
  }
}

await main();
