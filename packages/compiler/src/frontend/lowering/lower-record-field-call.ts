import * as ts from "../ts7/adapter.js";
import { DYN, type IrExpr } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { dynUndefinedExpr, type Lowerer } from "./lowerer.js";
import { probeLower } from "./lower-probe.js";
import { omittedArgFor } from "./lower-calls.js";
import { lowerGenericRecordUnionCall } from "./lower-generic-record-call.js";

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
    if (callee.type.kind !== "func") L.badType(access, L.typeOf(access));
    const params = callee.type.params;
    const args = call.arguments.map((a, i) => L.lowerExprExpecting(a, params[i]));
    // Optional/defaulted record methods use the same completed ABI as any
    // other function value: omitted trailing arguments become the slot's
    // undefined arm before the exact-arity call reaches the backend.
    for (let i = args.length; i < params.length; i++) {
      const absent = omittedArgFor(L, params[i]!, locOf(call));
      if (!absent) {
        L.unsupported("SC1090", call, "calls omitting a non-optional parameter of the callee's type");
      }
      args.push(absent);
    }
    return { kind: "callValue", callee, args, type: callee.type.ret, loc: locOf(call) };
  }
