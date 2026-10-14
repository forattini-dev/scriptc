import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(pkg, "native-checker/manifest.json"), "utf8"));
const patch = join(pkg, "native-checker", manifest.patch);
const hash = data => createHash("sha256").update(data).digest("hex");
const patchHash = hash(readFileSync(patch));
const cache = join(pkg, "node_modules/.cache/scriptc-tsgo", `${manifest.commit}-${patchHash.slice(0, 16)}`, `${process.platform}-${process.arch}`);
const output = join(cache, process.platform === "win32" ? "tsgo.exe" : "tsgo");
const receipt = join(cache, "build.json");
const packaged = join(pkg, "native-checker/bin", `${process.platform}-${process.arch}`, `${manifest.commit}-${patchHash.slice(0, 16)}`);
const packageChecker = () => {
  const packagedReceipt = join(packaged, "build.json");
  if (existsSync(packagedReceipt) && readFileSync(packagedReceipt, "utf8") === readFileSync(receipt, "utf8")) {
    const built = JSON.parse(readFileSync(receipt, "utf8"));
    const packagedBinary = join(packaged, process.platform === "win32" ? "tsgo.exe" : "tsgo");
    if (existsSync(packagedBinary) && hash(readFileSync(packagedBinary)) === built.binaryHash &&
        built.libraries.every(lib => existsSync(join(packaged, lib.name)) && hash(readFileSync(join(packaged, lib.name))) === lib.hash)) return;
  }
  mkdirSync(packaged, { recursive: true }); cpSync(cache, packaged, { recursive: true });
};
const run = (file, args, options = {}) => execFileSync(file, args, { windowsHide: true, encoding: "utf8", ...options });
if (existsSync(output) && existsSync(receipt)) {
  const prior = JSON.parse(readFileSync(receipt, "utf8"));
  if (prior.commit === manifest.commit && prior.patchHash === patchHash && prior.binaryHash === hash(readFileSync(output)) &&
      prior.libraries.every(lib => existsSync(join(cache, lib.name)) && hash(readFileSync(join(cache, lib.name))) === lib.hash)) {
    packageChecker();
    console.log(`Native checker ready: ${output}`);
    process.exit(0);
  }
}
mkdirSync(cache, { recursive: true });
const source = process.env.SCRIPTC_TSGO_SOURCE ? resolve(process.env.SCRIPTC_TSGO_SOURCE) : join(dirname(cache), "source");
if (!existsSync(join(source, ".git"))) {
  run("git", ["clone", "--filter=blob:none", "--no-checkout", manifest.repository, source], { stdio: "inherit" });
  run("git", ["sparse-checkout", "init", "--cone"], { cwd: source });
  run("git", ["sparse-checkout", "set", "cmd", "internal"], { cwd: source });
  run("git", ["checkout", manifest.commit], { cwd: source, stdio: "inherit" });
}
if (run("git", ["rev-parse", "HEAD"], { cwd: source }).trim() !== manifest.commit) throw new Error("Native checker source revision mismatch; use a separate pinned checkout");
try { run("git", ["apply", "--reverse", "--check", patch], { cwd: source, stdio: "pipe" }); }
catch {
  run("git", ["apply", "--check", patch], { cwd: source });
  run("git", ["apply", patch], { cwd: source });
}
if (run("git", ["diff", "--name-only", "HEAD"], { cwd: source }).trim() !== "internal/api/proto.go" ||
    run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: source }).trim() !== "") {
  throw new Error("Native checker source contains changes beyond the pinned patch; preserve them in a separate checkout");
}
const original = run("git", ["show", "HEAD:internal/api/proto.go"], { cwd: source });
if (readFileSync(join(source, "internal/api/proto.go"), "utf8").replaceAll("\r\n", "\n") !== original.replace("tuple := t.AsTupleType()", "tuple := t.TargetTupleType()")) {
  throw new Error("Native checker tuple patch differs from the reviewed source change");
}
const go = process.env.SCRIPTC_GO_BIN || "go";
try { run(go, ["version"]); }
catch { throw new Error("Building the patched TypeScript checker needs Go 1.26+; install Go or set SCRIPTC_GO_BIN to its executable"); }
run(go, ["build", "-tags", "noembed", "-trimpath", "-o", output, "./cmd/tsgo"], {
  cwd: source, stdio: "inherit", env: { ...process.env, GOMAXPROCS: "2", GOFLAGS: "-p=2" },
});
const libs = join(source, "internal/bundled/libs");
const libraries = readdirSync(libs).filter(name => /^lib.*\.d\.ts$/.test(name)).sort().map(name => {
  copyFileSync(join(libs, name), join(cache, name));
  return { name, hash: hash(readFileSync(join(cache, name))) };
});
writeFileSync(receipt, JSON.stringify({ ...manifest, patchHash, binaryHash: hash(readFileSync(output)), libraries }, null, 2) + "\n");
packageChecker();
console.log(`Native checker built: ${output}`);
