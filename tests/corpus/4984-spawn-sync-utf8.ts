/// <reference types="node" />
import { spawnSync } from "node:child_process";

const result = spawnSync("node", ["-e", "process.stdout.write(process.env.TEST_NATIVE); process.stderr.write('err'); process.exitCode=7"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, TEST_NATIVE: "ok" },
});
console.log(result.status ?? 1);
console.log(result.stdout ?? "missing");
console.log(result.stderr ?? "missing");

const missing = spawnSync("scriptc-no-such-executable-4984", [], { encoding: "utf8" });
console.log(missing.status === null);
console.log(missing.stdout === null);
console.log(missing.error !== undefined);
