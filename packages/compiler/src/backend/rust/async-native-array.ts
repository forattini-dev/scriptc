import { nativeDynamicArrayLiteral } from "./native-array-values.js";
import type { IrExpr, IrType, SrcLoc } from "../../ir/nodes.js";

interface AsyncArrayContext {
  line(value: string): void;
  nextName(prefix: string): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  emitExprWithValues(expr: IrExpr, values: readonly (readonly [IrExpr, string])[]): string;
}

type EmitValue = (expr: IrExpr, consume: (value: string) => void) => void;

/** Build dynamic storage in evaluation order. Appending each resolved element
 * before starting the next also snapshots a spread before a later await can
 * mutate its source. Nested literals get dynamic storage of their own. */
export function emitAsyncNativeArrayLiteral(
  expr: Extract<IrExpr, { kind: "arrayLit" }>,
  context: AsyncArrayContext,
  emitValue: EmitValue,
  consume: (value: string) => void,
): void {
  const dyn = context.rustType({ kind: "dyn" }, expr.loc);
  const output = context.nextName("sc_async_array");
  context.line(`let ${output}: runtime::JsArray<${dyn}> = runtime::array_new(Vec::new());`);
  const spreads = new Set(expr.spreads);
  const step = (index: number): void => {
    const element = expr.elems[index];
    if (element === undefined) {
      consume(`${dyn}::Array(${output})`);
      return;
    }
    const append = (value: string): void => {
      if (spreads.has(index)) {
        context.line(`{ let ${dyn}::Array(sc_spread) = (${value}) else { unreachable!("scriptc: typed array spread") }; runtime::array_extend(&${output}, &sc_spread); }`);
      } else {
        context.line(`runtime::array_push(&${output}, ${value});`);
      }
      step(index + 1);
    };
    const literal = nativeDynamicArrayLiteral(element);
    if (literal !== undefined) {
      emitAsyncNativeArrayLiteral(literal, context, emitValue, append);
    } else {
      emitValue(element, (value) => {
        const boxed: IrExpr = { kind: "dynFrom", value: element, type: { kind: "dyn" }, loc: element.loc };
        append(context.emitExprWithValues(boxed, [[element, value]]));
      });
    }
  };
  step(0);
}
