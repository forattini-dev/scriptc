// @rust-only
// @target bun
// @no-engine
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FileWithBytes = ReturnType<typeof Bun.file> & {
  bytes(): Promise<Uint8Array>;
};
type CryptoHasherValue = {
  update(value: Uint8Array): CryptoHasherValue;
  digest(encoding: "hex" | "base64"): string;
};
type BunWithHasher = typeof Bun & {
  CryptoHasher: new (algorithm: string) => CryptoHasherValue;
};

const root = mkdtempSync(join(tmpdir(), "scriptc-bun-hash-"));
const path = join(root, "value.txt");

async function main(): Promise<void> {
  writeFileSync(path, "native:rust");
  const bytes = await (Bun.file(path) as FileWithBytes).bytes();
  console.log(new (Bun as BunWithHasher).CryptoHasher("sha256").update(bytes).digest("hex"));
  rmSync(root, { recursive: true, force: true });
}

void main();
