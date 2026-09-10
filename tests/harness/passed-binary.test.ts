import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { discardPassedBinary } from "./passed-binary.js";

const directories: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-passed-binary-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("normal runs retain artifacts; opted-in passes retain source and a digest receipt", () => {
  const dir = scratch();
  const binary = join(dir, "program");
  const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  writeFileSync(binary, bytes);
  writeFileSync(join(dir, "program.rs"), "// generated source");
  vi.stubEnv("SCRIPTC_TEST_DISCARD_PASSED_BINARIES", "0");
  discardPassedBinary(dir, binary, "fixture.ts");
  expect(existsSync(binary)).toBe(true);
  expect(existsSync(`${binary}.passed.json`)).toBe(false);
  vi.stubEnv("SCRIPTC_TEST_DISCARD_PASSED_BINARIES", "1");
  discardPassedBinary(dir, binary, "fixture.ts");
  expect(existsSync(binary)).toBe(false);
  expect(readFileSync(join(dir, "program.rs"), "utf8")).toBe("// generated source");
  expect(JSON.parse(readFileSync(`${binary}.passed.json`, "utf8"))).toMatchObject({
    test: "fixture.ts", binary: "program", bytes: 4,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
});

test("cleanup cannot delete an outside artifact, directory or symbolic link", () => {
  vi.stubEnv("SCRIPTC_TEST_DISCARD_PASSED_BINARIES", "1");
  const dir = scratch();
  const outside = join(scratch(), "program");
  writeFileSync(outside, "retained");
  expect(() => discardPassedBinary(dir, outside, "fixture.ts")).toThrow("outside");
  expect(() => discardPassedBinary(dir, dir, "fixture.ts")).toThrow("outside");
  const link = join(dir, "program");
  symlinkSync(outside, link);
  expect(() => discardPassedBinary(dir, link, "fixture.ts")).toThrow("outside");
  expect(readFileSync(outside, "utf8")).toBe("retained");
  expect(existsSync(link)).toBe(true);
  const parent = join(dir, "linked-parent");
  symlinkSync(join(outside, ".."), parent, "dir");
  expect(() => discardPassedBinary(dir, join(parent, "program"), "fixture.ts")).toThrow("outside");
  expect(readFileSync(outside, "utf8")).toBe("retained");
});
