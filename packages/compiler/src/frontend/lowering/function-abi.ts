import type * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { omittedArgFor } from "./lower-calls.js";
import type { IrExpr, IrType } from "../../ir/ir.js";
import type { ParamShape } from "./lower-calls.js";

type IrFuncType = Extract<IrType, { kind: "func" }>;

/** Function values retain the producer's completed calling convention.
 * Typed and island rests spell their trailing array slot; dynamic rests
 * hide it from params and receive it from the boxed call thunk. */
export function functionAbi(shapes: readonly ParamShape[], ret: IrType, usesArguments = false): IrFuncType {
  const tail = shapes.at(-1);
  const restAbi = tail?.mode === "islandRest" ? "jsval"
    : tail?.mode === "rest" && tail.type.kind === "array" ? "array" : undefined;
  const rest = restAbi !== undefined || usesArguments || tail?.mode === "dynRest";
  return {
    kind: "func", params: shapes.filter(s => s.mode !== "dynRest").map(s => s.type), ret,
    ...(rest ? { rest: true } : {}), ...(restAbi ? { restAbi } : {}),
  };
}

/** Complete an indirect call once, including record/class/namespace fields. */
export function completeFunctionValueArgs(
  lowerer: Lowerer, call: ts.CallExpression, type: IrFuncType,
): IrExpr[] {
  const loc = locOf(call);
  if (type.restAbi === "array") {
    const shapes: ParamShape[] = type.params.map((param, i) => ({
      type: param, mode: i === type.params.length - 1 ? "rest" : "omittable",
    }));
    return lowerer.completeArgs(call.arguments, shapes, loc, call);
  }
  const args = call.arguments.map((a, i) => lowerer.lowerExprExpecting(a, type.params[i]));
  for (const param of type.params.slice(args.length)) {
    const absent = omittedArgFor(lowerer, param, loc);
    if (!absent) lowerer.unsupported("SC1090", call, "calls omitting a non-optional parameter of the callee's type");
    args.push(absent);
  }
  return args;
}
