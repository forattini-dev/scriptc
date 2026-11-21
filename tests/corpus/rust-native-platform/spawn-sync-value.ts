import { spawnSync } from "node:child_process";

function invoke(run: typeof spawnSync = spawnSync): string {
  const result = run(
    "node",
    ["-e", "process.stdout.write(process.env.SCRIPTC_SPAWN_VALUE || 'missing')"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      env: { ...process.env, SCRIPTC_SPAWN_VALUE: "function-value" },
    },
  );
  return `${result.status}:${result.stdout}`;
}

console.log("spawn value", invoke());
