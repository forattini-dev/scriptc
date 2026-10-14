import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as ts from "./ts7/adapter.js";
import { ProjectDeclarations } from "./project-declarations.js";

test("workspace declaration discovery preserves one Node world and custom ambient types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-node-type-world-"));
  const host = new ts.Ts7Host({ cwd: directory });
  try {
    const node = join(directory, "node_modules/@types/node");
    const workspace = join(directory, "workspace");
    const foreignNode = join(workspace, "node_modules/@types/node");
    const custom = join(workspace, "node_modules/@types/custom");
    for (const folder of [node, foreignNode, custom]) await mkdir(folder, { recursive: true });
    await writeFile(join(node, "index.d.ts"), `
      declare module "node:events" { export class EventEmitter { on(event: "exit", listener: (code: number) => void): this; } }
      declare module "node:child_process" { import { EventEmitter } from "node:events"; export class ChildProcess extends EventEmitter {} }
    `);
    await writeFile(join(foreignNode, "index.d.ts"), `declare module "node:events" { export class EventEmitter { incompatible(): void; } }`);
    await writeFile(join(custom, "index.d.ts"), `declare const workspaceMarker: "kept";`);
    for (const folder of [node, foreignNode, custom]) await writeFile(join(folder, "package.json"), JSON.stringify({ name: folder === custom ? "@types/custom" : "@types/node", types: "index.d.ts" }));
    await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: ["node", "custom"] }, include: ["*.ts"] }));
    const entry = join(workspace, "entry.ts");
    await writeFile(entry, `import { ChildProcess } from "node:child_process"; new ChildProcess().on("exit", code => { const typed: number = code; }); const marker: "kept" = workspaceMarker;`);
    const declarations = new ProjectDeclarations(host, join(node, "index.d.ts"));
    const roots = declarations.collect([entry]);
    expect(roots.some(root => root.replaceAll("\\", "/").includes("/workspace/node_modules/@types/node/"))).toBe(false);
    const program = host.createProgram([entry, join(node, "index.d.ts"), ...roots], { noLib: true, skipLibCheck: true, strict: true, types: [] });
    try {
      expect(program.getSemanticDiagnostics(program.getSourceFile(entry))).toEqual([]);
      expect(program.getSourceFiles().some(file => file.text.includes('workspaceMarker: "kept"'))).toBe(true);
      expect(program.getSourceFiles().some(file => file.text.includes("incompatible()"))).toBe(false);
    } finally { program.dispose(); }
  } finally {
    host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
