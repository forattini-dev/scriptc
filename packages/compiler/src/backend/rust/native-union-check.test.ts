import { expect, test } from "vitest";
import { F64, STRING, arrayOf, funcOf, type IrType } from "../../ir/nodes.js";
import { planNativeUnionVariants } from "./native-union-check.js";

test("native union dispatch refuses arms that need structural disambiguation", () => {
  const ambiguous: IrType[][] = [
    [arrayOf(F64), arrayOf(STRING)],
    [funcOf([F64], F64), funcOf([STRING], STRING)],
    [{ kind: "record", shapeId: "first" }, { kind: "record", shapeId: "second" }],
    [{ kind: "record", shapeId: "errorLike" }, { kind: "object", className: "%Error" }],
  ];
  for (const arms of ambiguous) {
    expect(planNativeUnionVariants({ id: "ambiguous", arms })).toBeNull();
    expect(planNativeUnionVariants({ id: "ambiguous", arms: [...arms].reverse() })).toBeNull();
  }
});

test("an unclassified dynamic arm cannot become a catch-all native match", () => {
  expect(planNativeUnionVariants({ id: "unknown", arms: [STRING, { kind: "dyn" }] })).toBeNull();
});
