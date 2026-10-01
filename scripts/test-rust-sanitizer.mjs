#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pin = process.env.SCRIPTC_RUST_SAN_TOOLCHAIN ?? "";
if (!/^nightly-\d{4}-\d{2}-\d{2}$/.test(pin)) {
  console.error("Rust ASan gate requires SCRIPTC_RUST_SAN_TOOLCHAIN=nightly-YYYY-MM-DD naming an installed toolchain; no tests were run.");
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL("../", import.meta.url));
  // Fail once at provisioning, rather than compiling the entire corpus only
  // to repeat the same missing-toolchain diagnostic for every fixture.
  const probe = spawn("rustup", ["run", pin, "rustc", "-vV"], { cwd: root, stdio: "inherit" });
  probe.on("error", error => { console.error(error.message); process.exitCode = 1; });
  probe.on("exit", (code, signal) => {
    if (code !== 0 || signal !== null) {
      console.error(`Rust ASan gate requires the installed toolchain ${pin}; no tests were run.`);
      process.exitCode = 1;
      return;
    }
    const child = spawn(process.execPath, [
      resolve(root, "node_modules/vitest/vitest.mjs"), "run",
      "tests/harness/rust-differential.test.ts", ...process.argv.slice(2),
    ], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, SCRIPTC_SAN: "1", SCRIPTC_RUST_SAN: "1" },
    });
    child.on("error", error => { console.error(error.message); process.exitCode = 1; });
    child.on("exit", (exitCode, exitSignal) => {
      if (exitSignal !== null) console.error(`Rust ASan gate terminated by ${exitSignal}`);
      process.exitCode = exitCode ?? 1;
    });
  });
}
