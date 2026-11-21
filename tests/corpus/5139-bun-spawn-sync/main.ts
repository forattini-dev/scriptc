/// <reference types="bun-types" />
const result = Bun.spawnSync(
  ["cmd.exe", "/d", "/c", "exit 3"],
  { stdout: "pipe", stderr: "ignore" },
);
console.log(result.exitCode, result.success);
