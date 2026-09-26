// util.promisify over a second statically-known error-first builtin. The
// projection routes fs.readFile onto the existing fs/promises lowering;
// success and rejection both retain Promise scheduling and Error shapes.
import { readFile } from "node:fs";
import { promisify } from "node:util";

const readFileAsync = promisify(readFile);

async function main(): Promise<void> {
  console.log("scheduled");
  const source = await readFileAsync(import.meta.filename, "utf8");
  console.log("read", source.includes("promisify over a second"), source.length > 100);
  try {
    await readFileAsync("/definitely/missing/scriptc-promisify-file", "utf8");
  } catch (error) {
    if (error instanceof Error) console.log("missing", error.name, error.message.includes("ENOENT"));
  }
}

main();
