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
import { compileRust } from "../packages/compiler/src/backend/rust/compile.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiler = process.env["SCRIPTC_NATIVE_COMPILER_BIN"] ?? join(root, "packages/compiler-rust/target/debug", process.platform === "win32" ? "scriptc.exe" : "scriptc");
const directory = mkdtempSync(join(tmpdir(), "scriptc-native-ir-contract-"));
const cases: { fixture: string; irVersion: number; referenceBackendAccepted: boolean; referenceBinaryParity?: boolean }[] = [];
async function main(): Promise<void> {
  try {
    for (const [index, fixture] of ["rust-native-frontend/main.ts", "rust-native-frontend/numbers.ts", "rust-native-frontend/plain.js", "rust-native-functions/main.ts", "rust-native-modules/main.ts", "rust-native-project/main.ts", "rust-native-builtins/main.ts", "rust-native-package/main.ts", "rust-native-json/main.ts", "rust-native-builtins/runtime-types-only.ts", "rust-native-builtins/process-import.ts", "rust-native-cycles/main.ts", "rust-native-records/main.ts", "rust-native-records/runtime-types-only.ts", "rust-native-callbacks/main.ts", "rust-native-callbacks/runtime-types-only.ts", "rust-native-js-contracts/contracts.ts", "rust-native-parameters/main.ts", "rust-native-parameters/function-values.ts", "rust-native-collections/main.ts", "rust-native-collections/scalar-map.ts", "rust-native-collections/runtime-types-only.ts", "rust-native-reachability/main.ts", "rust-native-storage/main.ts", "rust-native-storage/cycle.ts", "rust-native-storage/namespace.ts", "rust-native-map-seeds/main.ts", "rust-native-map-seeds/order.ts", "rust-native-map-seeds/contracts.ts", "rust-native-errors/main.ts", "rust-native-errors/contracts.ts", "rust-native-regex/main.ts", "rust-native-regex/contracts.ts", "rust-native-vars/main.ts", "rust-native-vars/cycle.ts", "rust-native-vars/contracts.ts", "rust-native-class-values/main.ts", "rust-native-class-values/contracts.ts"].entries()) {
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
      const sourcePath = join(directory, index + ".reference.rs");
      writeFileSync(sourcePath, rust);
      const referenceBinaryParity = fixture === "rust-native-callbacks/main.ts" || fixture === "rust-native-js-contracts/contracts.ts" || fixture.startsWith("rust-native-parameters/") || fixture === "rust-native-collections/main.ts" || fixture === "rust-native-collections/scalar-map.ts" || fixture === "rust-native-reachability/main.ts" || fixture.startsWith("rust-native-storage/") || fixture.startsWith("rust-native-map-seeds/") || fixture.startsWith("rust-native-errors/") || fixture.startsWith("rust-native-regex/") || fixture.startsWith("rust-native-vars/") || fixture.startsWith("rust-native-class-values/");
      if (referenceBinaryParity) {
        const outPath = join(directory, index + (process.platform === "win32" ? ".exe" : ".bin"));
        await compileRust({ sourcePath, outPath, optimization: "dev", runtimeFeatures: [], allowEngine: false });
        const expected = spawnSync(process.env["SCRIPTC_NODE_ORACLE"] ?? process.execPath, [join(root, "tests/corpus", fixture)], { windowsHide: true, timeout: 30_000 });
        const actual = spawnSync(outPath, [], { windowsHide: true, timeout: 30_000, env: { ...process.env, SCRIPTC_RUST_HEAP_AUDIT: "1" } });
        assert.ifError(expected.error); assert.ifError(actual.error);
        assert.equal(expected.status, 0, String(expected.stderr));
        assert.equal(actual.status, expected.status);
        assert.deepEqual(actual.stdout, expected.stdout);
        assert.deepEqual(actual.stderr, expected.stderr);
      }
      cases.push({ fixture, irVersion: mod.irVersion, referenceBackendAccepted: true, ...(referenceBinaryParity ? { referenceBinaryParity: true } : {}) });
    }
    console.log(JSON.stringify({ verdict: "PASS", cases }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
