/// <reference types="node" />
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const path = join(tmpdir(), "scriptc-5151-write-bytes.bin");
const bytes = Buffer.from([0, 255, 128, 10]);
writeFileSync(path, bytes, { mode: 0o600 });
console.log(readFileSync(path).join(","));
rmSync(path, { force: true });
