// @no-engine
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "scriptc-write-position-"));
const path = join(directory, "data.txt");
for (const position of [-1, -2, -3, 1.5, NaN]) {
  writeFileSync(path, ".....");
  const fd = openSync(path, "r+");
  writeSync(fd, "A");
  let code = "ok";
  try { writeSync(fd, "N", position); } catch (error) { code = (error as NodeJS.ErrnoException).code!; }
  writeSync(fd, "F");
  closeSync(fd);
  console.log(position, code, readFileSync(path, "utf8"));
}
rmSync(directory, { recursive: true, force: true });
