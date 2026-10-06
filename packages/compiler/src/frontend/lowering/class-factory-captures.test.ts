import { resolve } from "node:path";
import { expect, test } from "vitest";
import { validateModule } from "../../ir/validate.js";
import { loadProgram } from "../program.js";
import { lowerToIr } from "./lowerer.js";

test("two factory calls reserve independent capture cells and static globals", () => {
  const load = loadProgram(resolve("tests/corpus/3425-ts-class-factory-order.ts"));
  try {
    const result = lowerToIr(load.program, load.entry, load.moduleOrder);
    expect(result.diagnostics).toEqual([]);
    expect(result.runtimeFences).toEqual([]);
    if (!result.module) throw new Error("expected a lowered module");
    expect(validateModule(result.module)).toEqual([]);
    const globals = result.module.globals;
    if (!globals) throw new Error("expected module globals");
    const captures = globals.filter(global => global.id.includes(".capture"));
    expect(captures).toHaveLength(4);
    expect(new Set(captures.map(global => global.id)).size).toBe(4);
    expect(captures.every(global => global.mutable)).toBe(true);
    const statics = globals.filter(global => global.id.startsWith("%g.s.") && global.id.endsWith(".snapshot"));
    expect(statics).toHaveLength(2);
    expect(statics[0]?.id).not.toBe(statics[1]?.id);
    expect(new Set(globals.map(global => global.id)).size).toBe(globals.length);
  } finally { load.dispose(); }
});

test("builder factories retain distinct receiver objects and self-referencing class cells", () => {
  const load = loadProgram(resolve("tests/corpus/3431-js-class-builder-capture.mjs"));
  try {
    const result = lowerToIr(load.program, load.entry, load.moduleOrder);
    expect(result.diagnostics).toEqual([]);
    expect(result.runtimeFences).toEqual([]);
    if (!result.module) throw new Error("expected a lowered module");
    expect(validateModule(result.module)).toEqual([]);
    const globals = result.module.globals ?? [];
    const receivers = globals.filter(global => global.id.endsWith(".receiver"));
    const selves = globals.filter(global => global.id.endsWith(".self"));
    expect(receivers).toHaveLength(2);
    expect(selves).toHaveLength(2);
    expect(receivers.every(global => global.type.kind === "object")).toBe(true);
    expect(selves.every(global => global.type.kind === "classval")).toBe(true);
    expect(new Set(selves.map(global => global.type.kind === "classval" ? global.type.className : "")).size).toBe(2);
    expect(new Set(globals.map(global => global.id)).size).toBe(globals.length);
    // Two per-site specializations; Builder.build itself stays an ordinary
    // method whose class compiles once as a template (class-templates.ts).
    const commandRefs = result.module.classes?.filter(definition => definition.jsName === "CommandRef") ?? [];
    expect(commandRefs.filter(definition => definition.name.includes("%mx"))).toHaveLength(2);
    expect(commandRefs.filter(definition => !definition.name.includes("%mx"))).toHaveLength(2);
    const assignments = result.module.functions.flatMap(fn => fn.body).filter(statement => statement.kind === "assign");
    for (const receiver of receivers) {
      const selfId = receiver.id.replace(/\.receiver$/, ".self");
      const receiverIndex = assignments.findIndex(statement => statement.localId === receiver.id);
      const selfIndex = assignments.findIndex(statement => statement.localId === selfId);
      expect(receiverIndex).toBeGreaterThanOrEqual(0);
      expect(selfIndex).toBeGreaterThan(receiverIndex);
      expect(assignments[selfIndex]?.value.kind).toBe("classRef");
    }
    expect(result.module.functions.some(fn => fn.name.endsWith("ClassBuilder.build"))).toBe(false);
  } finally { load.dispose(); }
});
