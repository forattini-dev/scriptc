import type { Lowerer } from "./lowerer.js";
import {
  IrExpr,
  IrFunction,
  IrStmt,
  IrType,
  JSVAL,
  SrcLoc,
} from "../../ir/nodes.js";

/**
 * Adapt a dynamic module namespace to a static record of async methods.
 *
 * The namespace and each method remain engine handles. The record itself is
 * native, and every field is a typed Rust closure which preserves method
 * `this`, marshals arguments into the island, adopts the engine promise, and
 * validates its fulfilled value on the way back out.
 */
export function lowerIslandCallableRecordCast(
  L: Lowerer,
  value: IrExpr,
  target: IrType,
  loc: SrcLoc,
): IrExpr | null {
  if (value.type.kind !== "jsval" || target.kind !== "record") return null;
  const shape = L.shapes.get(target.shapeId);
  if (!shape || shape.tuple || shape.indexValue || shape.fields.length === 0) return null;

  const methods: {
    name: string;
    type: IrType & { kind: "func" };
    mode: "async" | "sync" | "syncRecord";
  }[] = [];
  for (const field of shape.fields) {
    if (field.type.kind !== "func" || field.type.rest === true ||
        !field.type.params.every((param) => L.jsvalLiftable(param))) return null;
    if (field.type.ret.kind === "promise" && L.boundaryExitSafe(field.type.ret.inner)) {
      methods.push({ name: field.name, type: field.type, mode: "async" });
      continue;
    }
    if (L.boundaryExitSafe(field.type.ret)) {
      methods.push({ name: field.name, type: field.type, mode: "sync" });
      continue;
    }
    if (field.type.ret.kind === "record") {
      const resultShape = L.shapes.get(field.type.ret.shapeId);
      if (resultShape && !resultShape.tuple && !resultShape.indexValue &&
          resultShape.fields.every((resultField) => L.boundaryExitSafe(resultField.type))) {
        methods.push({ name: field.name, type: field.type, mode: "syncRecord" });
        continue;
      }
    }
    return null;
  }

  const factoryName = `%fn${L.lambdaCounter++}_islandInterface`;
  const namespace = {
    localId: "namespace.0",
    name: "namespace",
    type: JSVAL,
  };
  const namespaceRef = (): IrExpr => ({
    kind: "varRef",
    localId: namespace.localId,
    type: JSVAL,
    loc,
  });
  const stmts: IrStmt[] = [];
  const locals: IrFunction["locals"] = [
    { id: namespace.localId, name: namespace.name, type: JSVAL, mutable: false, boxed: true },
  ];
  const fields: { name: string; value: IrExpr }[] = [];

  for (const [methodIndex, method] of methods.entries()) {
    const handle: IrFunction["locals"][number] = {
      id: `method.${methodIndex}`,
      name: `method${methodIndex}`,
      type: JSVAL,
      mutable: false,
      boxed: true,
    };
    locals.push(handle);
    stmts.push({
      kind: "varDecl",
      localId: handle.id,
      init: {
        kind: "jsOp",
        op: "getProp",
        name: method.name,
        args: [namespaceRef()],
        type: JSVAL,
        loc,
      },
      loc,
    });

    const fnName = `%fn${L.lambdaCounter++}_islandMethod`;
    const params = method.type.params.map((type, index) => ({
      localId: `p${index}.0`,
      name: `p${index}`,
      type,
    }));
    const handleCapture = { localId: "method.0", name: "method", type: JSVAL };
    const namespaceCapture = { localId: "namespace.0", name: "namespace", type: JSVAL };
    const handleRef: IrExpr = { kind: "varRef", localId: handleCapture.localId, type: JSVAL, loc };
    const capturedNamespaceRef: IrExpr = {
      kind: "varRef",
      localId: namespaceCapture.localId,
      type: JSVAL,
      loc,
    };
    const args = params.map((param): IrExpr =>
      L.jsvalLiftExpr(
        { kind: "varRef", localId: param.localId, type: param.type, loc },
        loc,
      ),
    );
    const raw: IrExpr = {
      kind: "jsOp",
      op: "callFnThis",
      args: [handleRef, capturedNamespaceRef, ...args],
      type: JSVAL,
      loc,
    };
    const asyncResult = method.type.ret.kind === "promise" ? method.type.ret.inner : null;
    const functionLocals: IrFunction["locals"] = [
      { id: handleCapture.localId, name: handleCapture.name, type: JSVAL, mutable: false, boxed: true },
      { id: namespaceCapture.localId, name: namespaceCapture.name, type: JSVAL, mutable: false, boxed: true },
      ...params.map((param) => ({ id: param.localId, name: param.name, type: param.type, mutable: false })),
    ];
    let body: IrStmt[];
    if (method.mode === "async") {
      if (asyncResult === null) return null;
      const bridged: IrExpr = {
        kind: "jsBridgePromise",
        value: raw,
        type: { kind: "promise", inner: JSVAL },
        loc,
      };
      const awaited: IrExpr = { kind: "awaitExpr", value: bridged, type: JSVAL, loc };
      body = [{
        kind: "return",
        value: { kind: "jsExit", value: awaited, type: asyncResult, loc },
        loc,
      }];
    } else if (method.mode === "sync") {
      body = [{
        kind: "return",
        value: { kind: "jsExit", value: raw, type: method.type.ret, loc },
        loc,
      }];
    } else {
      if (method.type.ret.kind !== "record") return null;
      const resultShape = L.shapes.get(method.type.ret.shapeId);
      if (!resultShape) return null;
      const resultLocal = { id: "result.0", name: "result", type: JSVAL, mutable: false };
      functionLocals.push(resultLocal);
      const resultRef = (): IrExpr => ({ kind: "varRef", localId: resultLocal.id, type: JSVAL, loc });
      body = [
        { kind: "varDecl", localId: resultLocal.id, init: raw, loc },
        {
          kind: "return",
          value: {
            kind: "recordLit",
            fields: resultShape.fields.map((resultField) => ({
              name: resultField.name,
              value: {
                kind: "jsExit",
                value: {
                  kind: "jsOp",
                  op: "getProp",
                  name: resultField.name,
                  args: [resultRef()],
                  type: JSVAL,
                  loc,
                },
                type: resultField.type,
                loc,
              },
            })),
            type: method.type.ret,
            loc,
          },
          loc,
        },
      ];
    }
    const lifted: IrFunction = {
      name: fnName,
      params,
      returnType: asyncResult ?? method.type.ret,
      locals: functionLocals,
      captures: [handleCapture, namespaceCapture],
      body,
      ...(method.mode === "async" ? { async: true as const } : {}),
      loc,
    };
    L.liftedFns.push(lifted);
    fields.push({
      name: method.name,
      value: {
        kind: "closure",
        fnName,
        captures: [handle.id, namespace.localId],
        type: method.type,
        loc,
      },
    });
  }

  L.liftedFns.push({
    name: factoryName,
    params: [namespace],
    returnType: target,
    locals,
    body: [
      ...stmts,
      { kind: "return", value: { kind: "recordLit", fields, type: target, loc }, loc },
    ],
    loc,
  });
  return {
    kind: "call",
    callee: factoryName,
    args: [value],
    type: target,
    loc,
  };
}
