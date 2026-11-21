// @rust-only
// @target bun
// @no-engine
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "scriptc-bun-write-bytes-"));
  const path = join(root, "payload.bin");
  const bytes = new Uint8Array([0, 255, 97]);
  const write = Bun.write(path, bytes);
  bytes[0] = 99;
  const count = await write;
  const written = readFileSync(path);
  console.log(count, written[0], written[1], written[2]);
  rmSync(root, { recursive: true, force: true });
}

void main();
