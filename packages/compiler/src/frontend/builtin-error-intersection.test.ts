import { expect, test } from "vitest";
import type { IrType } from "../ir/ir.js";
import { builtinErrorIntersection } from "./builtin-error-intersection.js";

const error = (className: string): IrType => ({ kind: "object", className });

test.each(["%TypeError", "%RangeError", "%SyntaxError", "%DOMException"])("%s retains its layout through the Error ancestor", className => {
  expect(builtinErrorIntersection([error(className), error("%Error")])).toEqual(error(className));
  expect(builtinErrorIntersection([error("%Error"), error(className)])).toEqual(error(className));
});

test("unrelated classes and refinements are not erased", () => {
  expect(builtinErrorIntersection([error("%TypeError"), error("%RangeError")])).toBeNull();
  expect(builtinErrorIntersection([error("%Error"), error("UserError")])).toBeNull();
  expect(builtinErrorIntersection([error("%Error"), { kind: "record", shapeId: "extra" }])).toBeNull();
  expect(builtinErrorIntersection([error("%Error"), null])).toBeNull();
  expect(builtinErrorIntersection([])).toBeNull();
});
