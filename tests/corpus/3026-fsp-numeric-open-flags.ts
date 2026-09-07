// Resident lock admission: numeric flags must preserve atomic exclusive
// creation, read/write access and existing contents without implicit truncate.
import { constants, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const path = join(tmpdir(), `scriptc-3026-${process.pid}.lock`);
const flags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR;
const first = await open(path, flags, 0o600);
await first.writeFile("owner", "utf8");
try {
  const duplicate = await open(path, flags);
  await duplicate.close();
  console.log("unexpected duplicate");
} catch (error) {
  if (error instanceof Error) console.log("duplicate", (error as NodeJS.ErrnoException).code);
}
await first.close();
console.log("retained", readFileSync(path, "utf8"));

const existing = await open(path, constants.O_CREAT | constants.O_RDWR);
const contents = await existing.readFile("utf8");
console.log("read", contents);
await existing.close();
const append = await open(path, constants.O_APPEND | constants.O_WRONLY);
await append.writeFile("+next", "utf8");
await append.close();
console.log("append", readFileSync(path, "utf8"));
const truncate = await open(path, constants.O_TRUNC | constants.O_WRONLY);
await truncate.close();
console.log("truncate", readFileSync(path, "utf8").length);
writeFileSync(path, "read-only");
const readonly = await open(path, fs.constants.O_RDONLY);
const readContents = await readonly.readFile("utf8");
console.log("readonly", readContents);
await readonly.close();
if (existsSync(path)) unlinkSync(path);
