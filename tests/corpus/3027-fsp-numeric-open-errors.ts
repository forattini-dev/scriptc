import { constants, existsSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const path = join(tmpdir(), `scriptc-3027-${process.pid}.txt`);
for (const flags of [NaN, 1.5, 2147483648, -2147483649]) {
  try {
    const handle = await open(path, flags);
    await handle.close();
    console.log("unexpected success");
  } catch (error) {
    if (error instanceof Error) console.log(error.name, (error as NodeJS.ErrnoException).code, error.message);
  }
}
console.log("absent", !existsSync(path));

const events: string[] = [];
function flags(): number { events.push("flags"); return constants.O_CREAT | constants.O_EXCL | constants.O_RDWR; }
function mode(): number { events.push("mode"); return 0o600; }
const handle = await open(path, flags(), mode());
await handle.close();
console.log(events.join(","));
try {
  await open(path, constants.O_RDONLY, -1);
} catch (error) {
  if (error instanceof Error) console.log("mode", error.name, (error as NodeJS.ErrnoException).code);
}
unlinkSync(path);
