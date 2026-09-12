import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflightTs7 } from "../src/frontend/program.js";
import { Ts7Host } from "../src/frontend/ts7/program-adapter.js";

const source = `import { read } from "node:fs";
read(3, new Uint8Array(4), 0, 4, () => {});
`;

test.each(["mjs", "ts"])("overload arity is checked in the correct phase for %s", async (extension) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-overload-preflight-"));
  const entry = join(dir, `main.${extension}`);
  await writeFile(entry, source);
  const host = new Ts7Host();
  try {
    const result = checkPreflightTs7(entry, host);
    if (extension === "mjs") expect(result.diags).toEqual([]);
    else expect(result.diags).toEqual([expect.objectContaining({
      code: "SC0001", message: expect.stringContaining("No overload expects 5 arguments"),
    })]);
  } finally { host.close(); }
});
