import { completeFunctionValueArgs } from "./function-abi.js";
import * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";
import { probeLower } from "./lower-probe.js";
import { lowerGenericRecordUnionCall } from "./lower-generic-record-call.js";
import { lowerFamilyCall } from "./lower-families.js";

/** Invoke a stored record callback using its concrete signature. */
  export function lowerRecordFieldCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (L.chainBlocked(call)) return null;
    const dispatched = lowerGenericRecordUnionCall(L, call, access);
    if (dispatched) return dispatched;
    if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "record") return null;
    const target = L.fieldTarget(access);
    // In a monomorphized union-generic body, control-flow can expose a
    // callable field from one constraint arm even when this concrete
    // instance has a narrower record shape that omits it. The branch is
    // normally unreachable (the discriminant selected another arm), but
    // it must still lower. Model the absent JS property as dyn undefined:
    // if control ever does reach it, dynCall throws the same catchable
    // TypeError as `undefined(...)` instead of inventing a native slot.
    if (!target) {
      const declaredCallee = L.mapTypeOf(L.typeOf(access));
      const probed = declaredCallee?.kind === "func" ? probeLower(L, access.expression) : null;
      if (probed?.type.kind === "record") {
        const concreteShape = L.shapes.get(probed.type.shapeId);
        if (
          concreteShape && !concreteShape.indexValue &&
          !concreteShape.fields.some((f) => f.name === access.name.text)
        ) {
          if (call.arguments.some((a) => ts.isSpreadElement(a))) {
            L.unsupported("SC1090", call, "spread arguments in calls through absent generic record fields");
          }
          const receiver = L.lowerExpr(access.expression);
          const callee: IrExpr = {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: receiver, loc: receiver.loc }],
            result: dynUndefinedExpr(locOf(access)),
            type: DYN,
            loc: locOf(access),
          };
          const args = call.arguments.map((arg) => L.lowerExprExpecting(arg, DYN));
          return { kind: "dynCall", callee, calleeName: access.getText(), args, type: DYN, loc: locOf(call) };
        }
      }
    }
    let callee = target
      ? L.maybeNarrow(L.fieldGetExpr(target, locOf(access), access), access)
      : null;
    if (!callee) return null;
    // A HYBRID (function-with-properties) field is callable through its
    // reserved %call slot — `colors.blue("x")` where blue also carries
    // `.bold` (the chalk shape).
    if (callee.type.kind === "record") callee = L.hybridCallUnwrap(callee);
    // A closure-FAMILY slot (a service interface's generic member): the call is the family's, at this instantiation.
    if (callee.type.kind === "genericFunc") return lowerFamilyCall(L, call, callee);
    if (callee.type.kind !== "func") L.badType(access, L.typeOf(access));
    const args = completeFunctionValueArgs(L, call, callee.type);
    return { kind: "callValue", callee, args, type: callee.type.ret, loc: locOf(call) };
  }
