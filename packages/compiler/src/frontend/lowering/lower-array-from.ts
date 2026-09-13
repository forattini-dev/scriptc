import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { locOf } from "../program.js";
import { DYN, F64, UNDEFINED_T, arrayOf, funcOf, isRefCounted, type IrExpr, type IrFunction, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
import { countedFor, varRef } from "../../ir/build.js";
import { typeKey } from "../type-mapper.js";
import { fenceProducedArrayElem, strCharsCall } from "./lower-containers.js";
import { lowerCollectionFromCall } from "./lower-collection-materialization.js";

/** `Array.from({ length: n }, mapfn)` — the counted-generation idiom — on
 * THE stdlib Array global. The source must be an OBJECT LITERAL whose
 * single property is `length` (the shape the idiom always spells; the
 * ArrayLike record never exists as a value). Desugars to an interned
 * synthetic loop calling the mapper with (undefined, i) exactly like JS —
 * the first argument is the dyn undefined singleton, matching the
 * checker's own `unknown` for it — and pushing each result. The loop
 * bound is `i <= n - 1`, which IS ToLength for the finite lengths that
 * terminate (fractional lengths truncate, negative/NaN produce an empty
 * array — Node-exact). Native collection sources use lowerCollectionFromCall;
 * other source shapes keep the fence. Null when the callee isn't an
 * Array-static access. */
export function lowerArrayFromCall(lowerer: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!lowerer.isStdlibGlobal(access.expression, "Array")) return null;
  if (access.name.text !== "from") return null;
  const loc = locOf(call);
  const args = call.arguments;
  const collection = lowerCollectionFromCall(lowerer, call);
  if (collection) return collection;
  // MAPPER-LESS `Array.from({ length: n })` (usually with an explicit
  // type argument — the pMap results-array idiom): a length-n array of
  // ABSENT slots, filled by index before any read. Union elements with
  // an undefined arm hold the interned undefined (JS-exact); other
  // refcounted elements hold NULL and must be assigned before they are
  // read (SEMANTICS.md 46). Scalar elements have no absent value that
  // isn't a LIE on read (0 where Node says undefined) — fenced.
  if (args.length === 1 && ts.isObjectLiteralExpression(args[0]!) && args[0]!.properties.length === 1) {
    const n = lowerLengthProp(lowerer, args[0]!.properties[0]!);
    if (n) {
      if (n.type.kind !== "f64") lowerer.badType(args[0]!, lowerer.typeOf(args[0]!));
      const arrT = lowerer.mapTypeOf(lowerer.typeOf(call));
      if (arrT?.kind !== "array") lowerer.badType(call, lowerer.typeOf(call));
      const elem = arrT.elem;
      const absent =
        elem.kind === "union" ? lowerer.wrappedUndefined(elem, loc) !== null : isRefCounted(elem);
      if (!absent) {
        lowerer.noLowering(
          `mapper-less Array.from({ length: n }) with '${lowerer.fmt(elem)}' elements`,
          call,
          "scalar slots would read 0/false/\"\" where Node reads undefined — " +
            "pass a mapper (Array.from({ length: n }, () => init)) instead",
        );
      }
      return { kind: "arrayNewLen", length: n, type: arrT, loc };
    }
  }
  // `Array.from(s)` on a STRING: the string iterator's code-point walk
  // into a fresh string[] (astral characters stay whole, where a
  // charAt/index walk would truncate the surrogate halves) — the same
  // interned helper `[...s]` lowers through.
  if (args.length === 1 && !ts.isObjectLiteralExpression(args[0]!)) {
    const src = lowerer.lowerExpr(args[0]!);
    if (src.type.kind === "string") return strCharsCall(lowerer, src, loc);
    lowerer.noLowering(
      "Array.from with this argument shape",
      call,
      "supported sources are { length: n }, strings, native arrays, homogeneous tuples, " +
        "Sets, Maps and immediate Map/Set iterator calls; thisArg and other iterable forms have no lowering",
    );
  }
  const n =
    args.length === 2 && ts.isObjectLiteralExpression(args[0]!) && args[0]!.properties.length === 1
      ? lowerLengthProp(lowerer, args[0]!.properties[0]!)
      : null;
  if (!n) {
    lowerer.noLowering(
      "Array.from with this argument shape",
      call,
      "supported sources are { length: n }, strings, native arrays, homogeneous tuples, " +
        "Sets, Maps and immediate Map/Set iterator calls; thisArg and other iterable forms have no lowering",
    );
  }
  if (n.type.kind !== "f64") lowerer.badType(args[0]!, lowerer.typeOf(args[0]!));
  const fnArg = lowerer.lowerExpr(args[1]!);
  // The mapper may declare any prefix of (v, i): v is the checker's own
  // `unknown` (Node passes undefined there — the dyn undefined singleton
  // here), i the index. The result type must be a legal array element.
  if (
    fnArg.type.kind !== "func" ||
    fnArg.type.params.length > 2 ||
    (fnArg.type.params.length >= 1 && fnArg.type.params[0]!.kind !== "dyn") ||
    (fnArg.type.params.length === 2 && fnArg.type.params[1]!.kind !== "f64")
  ) {
    lowerer.badType(args[1]!, lowerer.typeOf(args[1]!));
  }
  const fnT = fnArg.type as IrType & { kind: "func" };
  const fnRet = fnT.ret;
  if (fnRet.kind === "void" || fnRet.kind === "func") lowerer.badType(call, lowerer.typeOf(call));
  fenceProducedArrayElem(lowerer, call, "'Array.from({ length }, mapper)'", fnRet);
  const arity = fnT.params.length;
  const key = `fromLen:${typeKey(fnRet)}:${arity}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%arr.fromLen.${lowerer.arrHofHelpers.size}`;
    lowerer.arrHofHelpers.set(key, helper);
    lowerer.liftedFns.push(buildArrayFromLenFn(helper, fnRet, arity, loc));
  }
  return { kind: "call", callee: helper, args: [n, fnArg], type: arrayOf(fnRet), loc };
}

function lowerLengthProp(lowerer: Lowerer, prop: ts.ObjectLiteralElementLike): IrExpr | null {
  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "length") {
    return lowerer.lowerExprExpecting(prop.initializer, F64);
  }
  if (ts.isShorthandPropertyAssignment(prop) && (prop.name as ts.Identifier).text === "length") {
    return lowerer.lowerShorthandValue(prop);
  }
  return null;
}

/** The generation loop, from existing IR nodes:
 *
 *   out = [];
 *   for (i = 0; i <= n - 1; i++) out.push(f(undefined, i));
 *   return out;
 */
function buildArrayFromLenFn(name: string, fnRet: IrType, arity: number, loc: SrcLoc): IrFunction {
  const outT = arrayOf(fnRet);
  const fnT = funcOf([DYN, F64].slice(0, arity), fnRet);

  const undef: IrExpr = {
    kind: "dynFrom",
    value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
    type: DYN,
    loc,
  };
  const body: IrStmt[] = [
    { kind: "varDecl", localId: "out.0", init: { kind: "arrayLit", elems: [], type: outT, loc }, loc },
    countedFor(
      loc,
      { kind: "libCall", fn: "math.floor", args: [varRef("n.0", F64, loc)], type: F64, loc },
      () => [
        {
          kind: "exprStmt",
          expr: {
            kind: "arrIntrinsic",
            method: "push",
            receiver: varRef("out.0", outT, loc),
            args: [
              {
                kind: "callValue",
                callee: varRef("f.0", fnT, loc),
                args: [undef, varRef("i.0", F64, loc)].slice(0, arity),
                type: fnRet,
                loc,
              },
            ],
            type: F64,
            loc,
          },
          loc,
        },
      ],
    ),
    { kind: "return", value: varRef("out.0", outT, loc), loc },
  ];
  return {
    name,
    params: [
      { localId: "n.0", name: "n", type: F64 },
      { localId: "f.0", name: "f", type: fnT },
    ],
    returnType: outT,
    locals: [
      { id: "n.0", name: "n", type: F64, mutable: true },
      { id: "f.0", name: "f", type: fnT, mutable: true },
      { id: "out.0", name: "out", type: outT, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
    ],
    body,
    loc,
  };
}

