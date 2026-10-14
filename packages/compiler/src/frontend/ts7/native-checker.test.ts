import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { patchedCheckerPath } from "./native-checker.js";
import { Ts7Host } from "./program-adapter.js";

test("packaged checker works without the development cache and retains standard libraries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-packaged-checker-"));
  try {
    const binary = patchedCheckerPath();
    expect(binary).toBeDefined();
    if (!binary) throw new Error("prepare the native checker before testing its distribution");
    const pkg = resolve(import.meta.dirname, "../../..");
    const native = join(directory, "native-checker");
    await mkdir(native, { recursive: true });
    await cp(join(pkg, "native-checker/manifest.json"), join(native, "manifest.json"));
    await cp(join(pkg, "native-checker/tuple-reference.patch"), join(native, "tuple-reference.patch"));
    const manifest = JSON.parse(await readFile(join(native, "manifest.json"), "utf8")) as { commit: string };
    const built = JSON.parse(await readFile(join(dirname(binary), "build.json"), "utf8")) as { patchHash: string };
    const packaged = join(native, "bin", `${process.platform}-${process.arch}`, `${manifest.commit}-${built.patchHash.slice(0, 16)}`);
    await cp(dirname(binary), packaged, { recursive: true });
    const helper = join(directory, "src/frontend/ts7/native-checker.mjs");
    await mkdir(dirname(helper), { recursive: true });
    await writeFile(helper, await readFile(join(pkg, "dist/frontend/ts7/native-checker.js"), "utf8"));
    await cp(join(pkg, "dist/frontend/ts7/native-checker.js.map"), join(dirname(helper), "native-checker.js.map"));
    const isolated = await import(pathToFileURL(helper).href) as { patchedCheckerPath: () => string | undefined };
    const installed = isolated.patchedCheckerPath();
    expect(installed).toBe(join(packaged, process.platform === "win32" ? "tsgo.exe" : "tsgo"));
    if (!installed) throw new Error("packaged checker was not selected");
    const entry = join(directory, "main.ts");
    await writeFile(entry, 'const values: string[] = []; values.push("kept");');
    const host = new Ts7Host({ cwd: directory, binaryPath: installed });
    try {
      const program = host.createProgram([entry], { strict: true, types: [] });
      try { expect(program.getSemanticDiagnostics()).toEqual([]); }
      finally { program.dispose(); }
    } finally { host.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
