import { resolve } from "node:path";
import { expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { loadProgram } from "../program.js";
import { Lowerer } from "./lowerer.js";
import { closedClassFactoryShapeOf } from "./class-factory-shapes.js";

test.each([
  ["tests/corpus/3431-js-class-builder-capture.mjs", true, true],
  ["tests/corpus/3432-js-class-builder-order.mjs", true, true],
  ["tests/corpus/3433-ts-class-builder-capture.ts", true, false],
  ["tests/fixtures/class-factory/builder-effects.mjs", false, false],
  ["tests/fixtures/class-factory/builder-frame.mjs", false, false],
])("builder shape recognition is pure and retains the exact body: %s", (fixture, recognized, self) => {
  const load = loadProgram(resolve(fixture));
  try {
    const lowerer = new Lowerer(load.program, load.entry, load.moduleOrder, false);
    let command: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
    ts.walkPreorder(load.entry, node => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "command") command = node;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "command" &&
        node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        command = node.initializer;
      }
      return undefined;
    });
    if (!command) throw new Error("expected a command wrapper");
    const classes = lowerer.classes.size;
    const globals = lowerer.globalsList.length;
    const shape = closedClassFactoryShapeOf(lowerer, command);
    expect(shape !== null).toBe(recognized);
    if (recognized) {
      expect(shape?.fn).toBe(command);
      expect(shape?.factory?.method?.receiver.kind).toBe(ts.SyntaxKind.NewExpression);
      expect(shape?.factory?.method?.self !== undefined).toBe(self);
      expect(shape?.factory?.method?.closure.initializer?.kind).toBe(ts.SyntaxKind.ThisKeyword);
    }
    expect(lowerer.classes.size).toBe(classes);
    expect(lowerer.globalsList).toHaveLength(globals);
    expect(lowerer.classFactoryCaptures).toBeNull();
  } finally { load.dispose(); }
});
