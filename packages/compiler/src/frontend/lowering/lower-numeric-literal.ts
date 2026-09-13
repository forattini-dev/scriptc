import * as ts from "../ts7/adapter.js";
import { F64, type IrExpr, type SrcLoc } from "../../ir/ir.js";

export function lowerNumericLiteral(expr: ts.NumericLiteral, loc: SrcLoc): IrExpr {
  const value = Number(expr.text.replace(/_/g, ""));
  // Ask 4's representability input: a DECIMAL INTEGER source spelling
  // that does not survive the trip through f64 (parse, format back,
  // compare) rides the literal so the library integer-boundary check
  // can refuse on the author's source text. `expr.text` is the
  // scanner's COOKED value (already the nearest double), so the
  // source spelling comes from the file text; numeric separators are
  // spelling sugar and strip first. Round-tripping literals (every
  // integer within ±(2^53−1)) and non-integer spellings carry
  // nothing, so the IR is unchanged for programs that held their
  // numbers.
  const spelled = expr.getText().replace(/_/g, "");
  if (/^\d+$/.test(spelled) && String(Number(spelled)) !== spelled) {
    return { kind: "numLit", value: Number(spelled), spelling: spelled, type: F64, loc };
  }
  return { kind: "numLit", value, type: F64, loc };
}
