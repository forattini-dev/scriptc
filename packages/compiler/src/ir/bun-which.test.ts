import { expect, test } from "vitest";
import { validateBunWhich } from "./bun-which.js";
import { STRING, BOOL, NULL_T, UNDEFINED_T, type IrExpr, type IrUnionDef } from "./ir.js";

test("Bun.which validates both optional inputs and its nullable result", () => {
  const unions = new Map<string, IrUnionDef>([
    ["optional", { id: "optional", arms: [STRING, UNDEFINED_T] }],
    ["nullable", { id: "nullable", arms: [NULL_T, STRING] }],
    ["bad", { id: "bad", arms: [BOOL, UNDEFINED_T] }],
  ]);
  const loc = { file: "test.ts", start: 0, end: 1 };
  const option: IrExpr = { kind: "varRef", localId: "opts", type: { kind: "union", unionId: "optional" }, loc };
  const command: IrExpr = { kind: "strLit", value: "sh", type: STRING, loc };
  const expr: Extract<IrExpr, { kind: "libCall" }> = { kind: "libCall", fn: "bun.which", args: [command, option, option], type: { kind: "union", unionId: "nullable" }, loc };
  const validate = (value: typeof expr): string[] => {
    const errors: string[] = [];
    validateBunWhich(value, id => unions.get(id), message => errors.push(message));
    return errors;
  };
  expect(validate(expr)).toEqual([]);
  expect(validate({ ...expr, type: STRING })).toEqual(["libCall bun.which must return string | null"]);
  expect(validate({ ...expr, args: [command, { ...option, type: { kind: "union", unionId: "bad" } }, option] })).toEqual(["libCall bun.which arg 1 must be string | undefined"]);
  expect(validate({ ...expr, args: [command, option, command] })).toEqual(["libCall bun.which arg 2 must be string | undefined"]);
});
