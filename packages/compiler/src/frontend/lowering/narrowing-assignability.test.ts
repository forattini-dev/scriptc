import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { compile } from "../../index.js";
import * as ts from "../ts7/adapter.js";
import { NarrowingStability } from "./narrowing-stability.js";

test("stale narrowing widens only when the declared TS type fits the contextual slot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-narrowing-assignability-"));
  const decisions = new Map<string, (ts.Type | null)[]>();
  const original = NarrowingStability.prototype.widenedType;
  const query = vi.spyOn(NarrowingStability.prototype, "widenedType").mockImplementation(function (this: NarrowingStability, node) {
    const result = original.call(this, node);
    if (ts.isPropertyAccessExpression(node) && node.getText() === "box.value" && ts.isReturnStatement(node.parent)) {
      let parent: ts.Node | undefined = node.parent;
      while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
      if (parent && ts.isFunctionDeclaration(parent) && parent.name) {
        const name = parent.name.text;
        const results = decisions.get(name) ?? [];
        results.push(result);
        decisions.set(name, results);
      }
    }
    return result;
  });
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, `
      class Box {
        value: "left" | "right" | undefined = "left";
        change(): void { this.value = "right"; }
      }
      function wide(box: Box): string | undefined {
        if (box.value === "left") { box.change(); return box.value; }
        return undefined;
      }
      function exact(box: Box): "left" | undefined {
        if (box.value === "left") { box.change(); return box.value; }
        return undefined;
      }
      console.log(wide(new Box()), exact(new Box()));
    `);
    const result = await compile(entry, { outputKind: "ir", outDir: dir, outPath: join(dir, "main.ir.json") });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(decisions.get("wide")?.some((type) => type !== null)).toBe(true);
    expect(decisions.get("exact")?.length).toBeGreaterThan(0);
    expect(decisions.get("exact")?.every((type) => type === null)).toBe(true);
  } finally {
    query.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
