import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { analyze } from "../src/index.js";
import { Ts7Host } from "../src/frontend/ts7/program-adapter.js";

test("npm surface attribution releases the previous checker before probing candidates", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-npm-lifecycle-"));
  const live = new Set<Ts7Host>();
  let peak = 0;
  const createProgram = Ts7Host.prototype.createProgram;
  const close = Ts7Host.prototype.close;
  const creation = vi.spyOn(Ts7Host.prototype, "createProgram").mockImplementation(function (this: Ts7Host, ...args) {
    live.add(this);
    peak = Math.max(peak, live.size);
    return createProgram.apply(this, args);
  });
  const disposal = vi.spyOn(Ts7Host.prototype, "close").mockImplementation(function (this: Ts7Host) {
    try { return close.call(this); } finally { live.delete(this); }
  });
  const dependency = (name: string, body: string, types: string): void => {
    const path = join(directory, "node_modules", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name, type: "module", main: "index.js", types: "index.d.ts" }));
    writeFileSync(join(path, "index.js"), body);
    writeFileSync(join(path, "index.d.ts"), types);
  };
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    dependency("safe", "export const value = 42;\n", "export declare const value: number;\n");
    dependency("guard", "export function isText(value) { return Boolean(value); }\n", "export declare function isText(value: unknown): value is string;\n");
    const entry = join(directory, "main.ts");
    writeFileSync(entry, 'import { value } from "safe"; import { isText } from "guard"; function render(input: unknown): string { return isText(input) ? input.toUpperCase() : ""; } console.log(value, render("text"));\n');
    const { coverage } = analyze(entry, { backend: "rust", allowEngine: false, npmStatic: ["safe", "guard"] });
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.npmStatic).toContainEqual({ package: "safe", status: "static" });
    expect(coverage.npmStatic).toContainEqual(expect.objectContaining({ package: "guard", status: "fallback" }));
    expect(live.size).toBe(0);
    expect(peak).toBe(1);
  } finally {
    creation.mockRestore();
    disposal.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
