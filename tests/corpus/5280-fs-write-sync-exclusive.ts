/// <reference types="node" />
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scriptc-write-wx-"));
const text = join(dir, "text");
const bytes = join(dir, "bytes");

try {
  writeFileSync(text, "first", { mode: 0o600, flag: "wx" });
  let code = "missing";
  try {
    writeFileSync(text, "second", { flag: "wx" });
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code ?? "unknown";
  }
  writeFileSync(bytes, Buffer.from([0, 255, 7]), { mode: 0o600, flag: "wx" });
  console.log(`${readFileSync(text, "utf8")}|${code}|${readFileSync(bytes).join(",")}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
