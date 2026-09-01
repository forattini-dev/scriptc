import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nodeOracleExecutable } from "../../../tests/harness/oracle-environment.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

// The URL component surface the C lane covers through the differential
// corpus, run against Node on the Rust lane too: the `url` crate answers
// port/origin/username/password directly and needs adaptation only for the
// empty-vs-absent fragment rule, so these pin that the two lanes agree.
const FIXTURES = [
  "2830-url-port.ts",
  "2831-url-origin.ts",
  "2832-url-hash.ts",
  "2833-url-userinfo.ts",
  "2834-url-can-parse.ts",
];

for (const name of FIXTURES) {
  test(`Rust URL components match Node (${name})`, async () => {
    const fixture = resolve("tests/corpus", name);
    const dir = await mkdtemp(join(tmpdir(), "scriptc-rust-url-components-"));
    const result = await compile(fixture, {
      outDir: dir,
      outPath: join(dir, "program"),
      backend: "rust",
      optimization: "dev",
    });
    expect(
      result.ok,
      result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    ).toBe(true);
    if (!result.ok) return;

    const [node, rust] = await Promise.all([
      execFileAsync(nodeOracleExecutable(), [fixture]),
      execFileAsync(result.binaryPath, [], {
        env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" },
      }),
    ]);
    expect(rust.stdout).toBe(node.stdout);
    expect(rust.stderr).toBe(node.stderr);
  });
}
