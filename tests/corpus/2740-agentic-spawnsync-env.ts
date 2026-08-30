import { spawnSync } from "node:child_process";

if (process.argv[2] === "child") {
  console.log(process.env.AGENT_SLOT ?? "missing");
} else {
  const child = spawnSync(process.execPath, [process.argv[1], "child"], {
    encoding: "utf8",
    env: { AGENT_SLOT: "worker-7" },
  });
  console.log(child.status, child.stdout.trim(), child.stderr);
}
