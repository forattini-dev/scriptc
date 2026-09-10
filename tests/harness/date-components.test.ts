import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, NODE_COMPAT_MATRIX } from "@scriptc/compiler";
import { primaryOracleExecutable } from "./node-matrix.js";

const entry = join(import.meta.dirname, "../corpus/3116-native-date-components.ts");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
for (const backend of ["rust", "c", "llvm"] as const) {
  // Windows CRT TZ does not implement IANA names. The portable differential
  // corpus still checks construction in that host's configured local zone.
  test.skipIf(process.platform === "win32" || (sanitize && backend === "rust"))(
    `${backend} local Date construction matches Node across timezone transitions`, async () => {
      const outDir = mkdtempSync(join(tmpdir(), `scriptc-date-${backend}-`));
      try {
        const result = await compile(entry, {
          backend, sanitize, allowEngine: false, optimization: "dev",
          outDir, outPath: join(outDir, "program"),
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) return;
        expect(result.execution.engine).toBe("none");
        for (const tz of ["UTC", "America/New_York", "Australia/Lord_Howe", "Pacific/Apia", "America/Sao_Paulo", "Europe/Amsterdam"]) {
          const env = { ...process.env, TZ: tz, SCRIPTC_RUST_HEAP_AUDIT: "1" };
          const node = spawnSync(primaryOracleExecutable(NODE_COMPAT_MATRIX), [entry], { env, timeout: 10_000 });
          const native = spawnSync(result.binaryPath, [], { env, timeout: 10_000 });
          expect(node.error, tz).toBeUndefined();
          expect(node.status, tz).toBe(0);
          expect(native.error, tz).toBeUndefined();
          expect(native.signal, tz).toBeNull();
          expect(native.status, tz).toBe(node.status);
          expect(native.stdout.toString(), tz).toBe(node.stdout.toString());
          expect(native.stderr.toString(), tz).toBe(node.stderr.toString());
        }
      } finally { rmSync(outDir, { recursive: true, force: true }); }
    },
  );
}
