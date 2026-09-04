import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/* Text-asset imports — the Bun-target story. Bun's loader serves a
 * relative ".txt"/".md" import as the file CONTENT (the default binding is
 * a string; .md rides the standard `with { type: "text" }` attributes);
 * Node's ESM loader refuses both extensions. A compiled binary therefore
 * embeds the content at BUILD time: the default binding bakes into a
 * string global assigned in the importer's %init prelude, two importers
 * of the same document share one global, and the checker stays the
 * project's dialect (the ambient `declare module "*.txt"` types the
 * binding — exactly bun-types' surface). The goldens below were confirmed
 * against Bun itself (`bun run` of the same imports). Node has no oracle
 * here — these are Bun-only semantics. */

interface Outcome {
  stdout: string;
  exitCode: number;
}

function runToExit(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Outcome> {
  return new Promise((resolveRun) => {
    execFile(file, args, { encoding: "utf8", env }, (error, stdout) => {
      resolveRun({
        stdout,
        exitCode: error && typeof error.code === "number" ? error.code : 0,
      });
    });
  });
}

test.each(["rust", "c"] as const)("text assets embed at build time like Bun's loader (%s)", async (backend) => {
  const fixture = resolve("packages/compiler/test/fixtures/text-assets/src/main.ts");
  const dir = await mkdtemp(join(tmpdir(), `scriptc-text-assets-${backend}-`));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend,
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;
  const binary = await runToExit(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
  expect(binary.exitCode).toBe(0);
  expect(binary.stdout).toBe(`32 25\ngreeting from the asset\nline two\n"# Doc\\n\\nbody **text** here"\n`);
});

test("non-text type attributes fence", async () => {
  const fixture = resolve("packages/compiler/test/fixtures/text-assets/src/bad-attribute.ts");
  const result = await compile(fixture, {
    outDir: await mkdtemp(join(tmpdir(), "scriptc-text-assets-fence-")),
    outPath: join(await mkdtemp(join(tmpdir(), "scriptc-text-assets-fence-out-")), "program"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
  expect(messages).toContain("only 'type: \"text\"' and 'type: \"file\"' serve assets");
});

test("named imports of text assets fence", async () => {
  const fixture = resolve("packages/compiler/test/fixtures/text-assets/src/named-fence.ts");
  const result = await compile(fixture, {
    outDir: await mkdtemp(join(tmpdir(), "scriptc-text-assets-named-")),
    outPath: join(await mkdtemp(join(tmpdir(), "scriptc-text-assets-named-out-")), "program"),
    backend: "rust",
    optimization: "dev",
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
  expect(messages).toContain("named imports of text assets");
});

test.each(["rust", "c"] as const)("file assets embed, extract, and answer the path (%s)", async (backend) => {
  const fixture = resolve("packages/compiler/test/fixtures/text-assets/src/asset-fs.ts");
  const dir = await mkdtemp(join(tmpdir(), `scriptc-file-assets-${backend}-`));
  const result = await compile(fixture, {
    outDir: dir,
    outPath: join(dir, "program"),
    backend,
    optimization: "dev",
  });
  expect(
    result.ok,
    result.ok ? fixture : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
  ).toBe(true);
  if (!result.ok) return;
  const binary = await runToExit(result.binaryPath, [], { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" });
  expect(binary.exitCode).toBe(0);
  // Bun-source parity note: bun answers the SOURCE file's path for a
  // type:"file" import; a compiled binary embeds and extracts (Bun's own
  // --compile does the same). The program verifies the extraction
  // end-to-end: the answered path ends in .mp3, exists, and its bytes are
  // the embedded content (30 bytes: 0x49 0x44 0x33 0x00 0xFF 0x0A ...).
  expect(binary.stdout).toBe("string true\n30 73 255 10\n32\n");
});