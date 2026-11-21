// @rust-only
// @target bun
// @no-engine
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FileWithBytes = ReturnType<typeof Bun.file> & {
  bytes(): Promise<Uint8Array>;
};

const root = mkdtempSync(join(tmpdir(), "scriptc-bun-bytes-"));
const path = join(root, "value.txt");

async function main(): Promise<void> {
  writeFileSync(path, "native:rust");
  const file = Bun.file(path);
  const stored = await (file as unknown as FileWithBytes).bytes();
  console.log(stored.length, stored[0], stored[10]);
  const direct = await (Bun.file(path) as FileWithBytes).bytes();
  console.log(direct.length, direct[0], direct[10]);
}

async function run(): Promise<void> {
  await main();
  rmSync(root, { recursive: true, force: true });
}

void run();
