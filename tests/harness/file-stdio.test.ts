import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { runFileStdio } from "./file-stdio.js";

test("file stdio captures console output and stderr without dropping either stream", async () => {
  const result = await runFileStdio(process.execPath, ["-e", 'console.log("stdout"); console.error("stderr");']);
  expect(result.code).toBe(0);
  expect(result.signal).toBe(null);
  expect(result.stdout).toEqual(Buffer.from("stdout\n"));
  expect(result.stderr).toEqual(Buffer.from("stderr\n"));
});

test("file stdio preserves non-UTF8 bytes and a nonzero exit code", async () => {
  const result = await runFileStdio(process.execPath, ["-e", 'require("node:fs").writeSync(1, Buffer.from([0, 255, 254])); process.exit(7);']);
  expect(result.code).toBe(7);
  expect(result.signal).toBe(null);
  expect(result.stdout).toEqual(Buffer.from([0, 255, 254]));
  expect(result.stderr).toEqual(Buffer.alloc(0));
});

test("file stdio rejects a failed spawn rather than reporting a successful empty run", async () => {
  await expect(runFileStdio(join(tmpdir(), "scriptc-file-stdio-missing", "no-executable"), [])).rejects.toMatchObject({ code: "ENOENT" });
});
