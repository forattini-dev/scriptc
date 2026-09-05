import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  RUNTIME_TARGETS,
  activeRuntimeConditions,
  describeRuntimeTargetOrigin,
  resolveRuntimeTarget,
  runtimeTargetKey,
  setActiveRuntimeTarget,
} from "./runtime-target.js";

const dirs: string[] = [];
async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-target-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}
afterEach(async () => {
  setActiveRuntimeTarget(RUNTIME_TARGETS.node24);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const noEnv: NodeJS.ProcessEnv = {};

test("an explicit target wins over every project pin", async () => {
  const dir = await project({ "package.json": '{"packageManager":"bun@1.3.14"}', "src/main.ts": "" });
  const resolved = resolveRuntimeTarget(join(dir, "src/main.ts"), "node26", noEnv);
  expect(resolved.profile.id).toBe("node26");
  expect(resolved.origin).toEqual({ kind: "flag" });
  expect(describeRuntimeTargetOrigin(resolved)).toBeNull();
});

test("a bun packageManager pin infers the bun target and says so", async () => {
  const dir = await project({
    "package.json": '{"packageManager":"bun@1.3.14","workspaces":["packages/*"]}',
    "packages/app/package.json": '{"name":"app"}',
    "packages/app/src/main.ts": "",
  });
  const resolved = resolveRuntimeTarget(join(dir, "packages/app/src/main.ts"), undefined, noEnv);
  expect(resolved.profile.id).toBe("bun");
  expect(resolved.origin).toMatchObject({ kind: "project", field: "packageManager" });
  expect(describeRuntimeTargetOrigin(resolved, dir)).toBe(
    "target: bun (inferred from packageManager in package.json; pass --target to choose)",
  );
});

test(".node-version and engines.node pick the Node major; unknown majors fall to node24", async () => {
  const nodeVersion = await project({ ".node-version": "26.8.1\n", "src/main.ts": "" });
  expect(resolveRuntimeTarget(join(nodeVersion, "src/main.ts"), undefined, noEnv).profile.id).toBe("node26");
  const engines = await project({ "package.json": '{"engines":{"node":">=24.0.0"}}', "src/main.ts": "" });
  const fromEngines = resolveRuntimeTarget(join(engines, "src/main.ts"), undefined, noEnv);
  expect(fromEngines.profile.id).toBe("node24");
  expect(fromEngines.origin).toMatchObject({ kind: "project", field: "engines.node" });
  const old = await project({ ".nvmrc": "20\n", "src/main.ts": "" });
  const fallback = resolveRuntimeTarget(join(old, "src/main.ts"), undefined, noEnv);
  expect(fallback.profile.id).toBe("node24");
  expect(fallback.origin).toEqual({ kind: "default" });
});

test("SCRIPTC_RUNTIME_TARGET selects when no flag does, and rejects unknown ids", async () => {
  const dir = await project({ "src/main.ts": "" });
  const resolved = resolveRuntimeTarget(join(dir, "src/main.ts"), undefined, { SCRIPTC_RUNTIME_TARGET: "bun" });
  expect(resolved.profile.id).toBe("bun");
  expect(resolved.origin).toEqual({ kind: "env", variable: "SCRIPTC_RUNTIME_TARGET" });
  expect(() => resolveRuntimeTarget(join(dir, "src/main.ts"), undefined, { SCRIPTC_RUNTIME_TARGET: "deno" })).toThrow(
    /unknown target "deno"/,
  );
});

test("the active conditions are the profile's in match order plus --conditions, deduplicated", () => {
  setActiveRuntimeTarget(RUNTIME_TARGETS.bun, ["browser", "node", ""]);
  expect(activeRuntimeConditions()).toEqual(["bun", "node", "import", "default", "browser"]);
  expect(runtimeTargetKey(RUNTIME_TARGETS.bun, ["browser"])).toBe(
    'bun:{"node":"24.15.0","bun":"1.3.14"}:bun,node,import,default,browser',
  );
  setActiveRuntimeTarget(RUNTIME_TARGETS.node24);
  expect(activeRuntimeConditions()).toEqual(["node", "import", "default"]);
});
