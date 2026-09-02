import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A runtime-valued encoding selects both the decoding and the return type.
const dir = mkdtempSync(join(tmpdir(), "scriptc-2867-"));
const file = join(dir, "body.txt");

try {
  writeFileSync(file, "hé");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercise Node's runtime-valued overload
  const read = (encoding: any): any => readFileSync(file, encoding);
  const text = read("utf8") as string;
  const bytes = read(undefined) as Buffer;
  const optionsText = read({ encoding: "utf8" }) as string;

  console.log(typeof text, text);
  console.log(bytes.toString("hex"));
  console.log(typeof optionsText, optionsText);

  try {
    read("wat");
  } catch (error: unknown) {
    const caught = error as NodeJS.ErrnoException;
    console.log(caught.name, caught.code, caught.message);
  }

  for (const encoding of [
    "hex", "base64", "base64url", "latin1", "ascii", "utf16le", "UCS-2",
  ]) {
    console.log(encoding, JSON.stringify(read(encoding) as string));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
