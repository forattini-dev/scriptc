import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isJsSourceFile, locOf } from "../program.js";
import { arrayOf, typeEquals, type IrExpr, type IrType } from "../../ir/ir.js";
import { lowerCollectionSetSeed } from "./lower-collection-materialization.js";

/** Construct a fresh Set while retaining each seed element's identity. */
export function lowerSetNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr {
  const loc = locOf(expr);
  const tsType = lowerer.typeOf(expr);
  const mapped = lowerer.mapTypeOf(tsType);
  if (mapped?.kind === "set" && (expr.arguments?.length ?? 0) === 1) {
    const argNode = expr.arguments![0]!;
    const collectionSeed = lowerCollectionSetSeed(lowerer, argNode, mapped.elem);
    if (collectionSeed) return { kind: "setNew", seed: collectionSeed, type: mapped, loc };
    // An array LITERAL seed builds element-wise (its contextual type
    // is the lib constructor's `readonly T[] | Iterable<T> | null`
    // union — unmappable, so the generic literal path can't type it);
    // an array-typed VALUE seed lowers as itself.
    if (ts.isArrayLiteralExpression(argNode)) {
      const seed = lowerer.lowerExprExpecting(argNode, arrayOf(mapped.elem));
      return { kind: "setNew", seed, type: mapped, loc };
    }
    if (!ts.isSpreadElement(argNode)) {
      const argIr = lowerer.mapTypeOf(lowerer.typeOf(argNode));
      if (argIr?.kind === "array" && typeEquals(argIr.elem, mapped.elem)) {
        let seed = lowerer.lowerExpr(argNode);
        // A T[]-DECLARED seed whose value is an island handle (a
        // package's exported array — the binding never held a
        // static array): the VALIDATED exit copies the engine
        // array out (strict elements, the catchable TypeError on a
        // lying handle), and the bulk add proceeds on the copy —
        // construction reads the seed once, so the aliasing
        // divergence has nothing to observe.
        if (seed.type.kind === "jsval" && lowerer.boundaryExitSafe(arrayOf(mapped.elem))) {
          seed = { kind: "jsExit", value: seed, type: arrayOf(mapped.elem), loc: seed.loc };
        }
        if (typeEquals(seed.type, arrayOf(mapped.elem))) {
          return { kind: "setNew", seed, type: mapped, loc };
        }
        // Any other lowered kind falls through to the named fence
        // below — never a mistyped seed into the validator.
      }
    }
  }
  // JavaScript's identity-Set idiom: `new Set([setTimeout, atob,
  // ...])` — the element TYPE (a union of stdlib signatures) has no
  // mapping, but the element VALUES all lower to identity tokens
  // (interned strings — see the JS token stance in lower-exprs), so
  // the honest construction is a Set of those scalars.
  if (
    !mapped &&
    isJsSourceFile(expr.getSourceFile()) &&
    (expr.arguments?.length ?? 0) === 1 &&
    ts.isArrayLiteralExpression(expr.arguments![0]!) &&
    !(expr.arguments![0] as ts.ArrayLiteralExpression).elements.some(ts.isSpreadElement)
  ) {
    const lit = expr.arguments![0] as ts.ArrayLiteralExpression;
    const elems = lit.elements.map((el) => lowerer.lowerExpr(el));
    const first = elems[0];
    if (
      first !== undefined &&
      (first.type.kind === "string" || first.type.kind === "f64") &&
      elems.every((e) => e.type.kind === first.type.kind)
    ) {
      const setT: IrType = { kind: "set", elem: first.type };
      const seed: IrExpr = { kind: "arrayLit", elems, type: arrayOf(first.type), loc };
      return { kind: "setNew", seed, type: setT, loc };
    }
  }
  if ((expr.arguments?.length ?? 0) > 0) {
    lowerer.noLowering(
      "new Set(values)",
      expr,
      "native arrays, homogeneous tuples, Sets, strings and immediate Map/Set iterator calls " +
        "can seed a Set of matching supported elements; other iterable forms have no lowering",
    );
  }
  if (mapped?.kind === "set") return { kind: "setNew", type: mapped, loc };
  const targs = lowerer.checker.getTypeArguments(tsType as ts.TypeReference);
  if (targs[0]) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `Set elements of type '${lowerer.checker.typeToString(targs[0])}' ` +
        `(Set elements must be string or number, or a record/callback/symbol/server handle stored under reference identity)`,
    );
  }
  lowerer.badType(expr, tsType);
}
