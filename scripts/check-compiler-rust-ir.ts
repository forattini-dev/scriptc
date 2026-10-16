// Test-only interoperability oracle. The native compiler never loads this file.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deserializeModule } from "../packages/compiler/src/ir/serialize.js";
import { validateModule } from "../packages/compiler/src/ir/validate.js";
import { emitRustModule } from "../packages/compiler/src/backend/rust/emitter.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiler = process.env["SCRIPTC_NATIVE_COMPILER_BIN"] ?? join(root, "packages/compiler-rust/target/debug", process.platform === "win32" ? "scriptc.exe" : "scriptc");
const directory = mkdtempSync(join(tmpdir(), "scriptc-native-ir-contract-"));
const cases: { fixture: string; irVersion: number; referenceBackendAccepted: boolean }[] = [];
try {
  for (const [index, fixture] of ["rust-native-frontend/main.ts", "rust-native-frontend/numbers.ts", "rust-native-frontend/plain.js", "rust-native-functions/main.ts", "rust-native-modules/main.ts", "rust-native-project/main.ts", "rust-native-builtins/main.ts", "rust-native-package/main.ts", "rust-native-json/main.ts", "rust-native-builtins/runtime-types-only.ts", "rust-native-builtins/process-import.ts", "rust-native-cycles/main.ts"].entries()) {
    const output = join(directory, index + ".json");
    const result = spawnSync(resolve(compiler), ["build", join(root, "tests/corpus", fixture), "--emit", "ir", "--out", output], {
      encoding: "utf8", timeout: 30_000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).engine, "none");
    const mod = deserializeModule(readFileSync(output, "utf8"));
    assert.equal(mod.irVersion, 13);
    assert.deepEqual(validateModule(mod), []);
    assert.equal(mod.embedded, undefined);
    const rust = emitRustModule(mod);
    assert.ok(rust.includes("fn main()"));
    assert.ok(!rust.includes("island_eval"));
    writeFileSync(join(directory, index + ".reference.rs"), rust);
    cases.push({ fixture, irVersion: mod.irVersion, referenceBackendAccepted: true });
  }
  console.log(JSON.stringify({ verdict: "PASS", cases }));
} finally { rmSync(directory, { recursive: true, force: true }); }
