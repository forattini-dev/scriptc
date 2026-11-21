/// <reference types="bun-types" />
/// <reference types="node" />
import { rmSync, writeFileSync } from "node:fs";

const path = ".scriptc-bun-file-text-test";
writeFileSync(path, "native");
async function read(): Promise<void> {
  const value = await Bun.file(path).text();
  console.log(value);
  rmSync(path, { force: true });
}

void read();
