// @rust-only
// @target bun
// @no-engine
async function main(): Promise<void> {
  const file = Bun.file("tests/corpus/rust-bun-file-text/metadata.ts");
  console.log(await file.exists(), file.size > 0, (await file.bytes()).byteLength > 0);
  const missing = Bun.file("tests/corpus/rust-bun-file-text/definitely-missing.bin");
  console.log(await missing.exists(), missing.size);
}

void main();
