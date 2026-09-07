import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "vitest";

test.skipIf(process.platform === "win32")("resource limiter forwards sanitizer mode to the transient service", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-limit-env-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const capture = join(dir, "arguments.json");
    const executable = join(bin, "systemd-run");
    writeFileSync(executable, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
`);
    chmodSync(executable, 0o755);
    execFileSync(process.execPath, [join(import.meta.dirname, "../../scripts/run-resource-limited.mjs"), "--", "node", "example.js"], {
      env: { ...process.env, PATH: bin + delimiter + process.env["PATH"], SCRIPTC_SAN: "1", SCRIPTC_LIMIT_MEMORY: "3G",
        TMPDIR: join(dir, "tmp"), CARGO_TARGET_DIR: join(dir, "cargo"),
      },
    });
    const args = JSON.parse(readFileSync(capture, "utf8")) as string[];
    expect(args).toContain("SCRIPTC_SAN=1");
    expect(args[args.indexOf("SCRIPTC_SAN=1") - 1]).toBe("--setenv");
    expect(args).toContain("MemoryMax=3G");
    expect(args.slice(-3)).toEqual(["--", "node", "example.js"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
