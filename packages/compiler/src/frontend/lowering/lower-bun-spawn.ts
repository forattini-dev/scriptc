import * as ts from "../ts7/adapter.js";
import { BOOL, CHILD_T, DYN, F64, NULL_T, STRING, arrayOf, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { isBunSubprocess } from "../bun-subprocess-type.js";
import { isBunGlobalMember } from "./bun-global.js";
import type { Lowerer } from "./lowerer.js";

export function lowerBunSpawnCall(L: Lowerer, call: ts.CallExpression, callee: ts.Expression): IrExpr | null {
  if (!isBunGlobalMember(L, callee, "spawn")) {
    if (ts.isPropertyAccessExpression(callee) && isBunSubprocess(L.typeOf(callee.expression), L)) {
      L.noLowering(`Bun.Subprocess.${callee.name.text}`, call, "only exited, pid, exitCode, killed, stdout and stderr reads are supported");
    }
    return null;
  }
  if (call.arguments.length < 1 || call.arguments.length > 2 || call.arguments.some(ts.isSpreadElement)) {
    L.noLowering("Bun.spawn arguments", call, "pass a string argv array and optional inline options");
  }
  if (ts.isObjectLiteralExpression(call.arguments[0]!)) L.noLowering("Bun.spawn object overload", call);
  const loc = locOf(call), stmts: IrStmt[] = [];
  const capture = (value: IrExpr): IrExpr => {
    const local = L.declareHiddenLocal("%bunSpawn", value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
    return varRef(local.id, value.type, loc);
  };
  const argv = capture(L.lowerExprExpecting(call.arguments[0]!, arrayOf(STRING)));
  const options = call.arguments[1];
  if (options && !ts.isObjectLiteralExpression(options)) L.noLowering("Bun.spawn non-literal options", options);
  let stdin = 0, stdout = 2, stderr = 1;
  let cwd: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  let env: IrExpr = { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };
  let hasEnv = false;
  // Capture each expression in source order, including overwritten properties.
  // Unsupported fields and spreads must not disappear during option projection.
  for (const property of options?.properties ?? []) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) L.noLowering("Bun.spawn option spread or accessor", property);
    const key = property.name;
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) L.noLowering("Bun.spawn computed option", key);
    const name = key.text, value = ts.isPropertyAssignment(property) ? property.initializer : key;
    if (name === "stdin" || name === "stdout" || name === "stderr") {
      if (!ts.isStringLiteral(value) || !["ignore", "inherit", ...(name === "stdin" ? [] : ["pipe"])].includes(value.text)) L.noLowering(`Bun.spawn ${name}`, value, "pass literal ignore/inherit or an output pipe; stdin FileSink and file descriptors are unsupported");
      const mode = value.text === "inherit" ? 1 : value.text === "pipe" ? 2 : 0;
      if (name === "stdin") stdin = mode;
      else if (name === "stdout") stdout = mode;
      else stderr = mode;
    } else if (name === "cwd") cwd = capture(L.lowerExprExpecting(value, STRING));
    else if (name === "env") {
      const record = capture(L.lowerExpr(value));
      if (record.type.kind !== "record") L.noLowering("Bun.spawn env", value, "pass a string-keyed record");
      // Enumerate the complete object through its shared dictionary view.
      // Inferred named fields alone omit keys copied by ...process.env.
      const envType: IrType = { kind: "record", shapeId: L.shapes.intern([], false, L.withUndefinedArm(STRING)) };
      const dictionary = L.coerceToExpected(record, envType);
      const helper = L.envToPairsHelper(envType.shapeId, loc);
      if (!helper) L.noLowering("Bun.spawn env values", value, "env fields must be strings or undefined");
      // Bun enumerates the captured environment at invocation, after all options
      // have evaluated. A later cwd expression may mutate this same record.
      env = { kind: "call", callee: helper, args: [dictionary], type: arrayOf(STRING), loc };
      hasEnv = true;
    }
    else L.noLowering(`Bun.spawn option '${name}'`, property);
  }
  const result: IrExpr = {
    kind: "libCall", fn: "bun.spawn", args: [argv, ...[stdin, stdout, stderr].map(value => ({ kind: "numLit" as const, value, type: F64, loc })),
      { kind: "boolLit", value: hasEnv, type: BOOL, loc }, env, cwd], type: CHILD_T, loc,
  };
  return { kind: "seqExpr", stmts, result, type: CHILD_T, loc };
}

export function lowerBunSubprocessProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (!L.nativeDenseArrays || !isBunSubprocess(L.typeOf(expr.expression), L)) return null;
  const loc = locOf(expr), value = L.lowerExpr(expr.expression), name = expr.name.text;
  if (expr.questionDotToken) L.noLowering("optional Bun.Subprocess property", expr);
  if (name === "exited") return { kind: "libCall", fn: "bun.exited", args: [value], type: { kind: "promise", inner: F64 }, loc };
  if (name === "pid") return { kind: "libCall", fn: "bun.pid", args: [value], type: F64, loc };
  if (name === "exitCode") return { kind: "libCall", fn: "bun.exitCode", args: [value], type: { kind: "union", unionId: L.unions.intern([F64, NULL_T]) }, loc };
  if (name === "killed") return { kind: "libCall", fn: "child.killed", args: [value], type: BOOL, loc };
  if (name === "stdout" || name === "stderr") return { kind: "libCall", fn: name === "stdout" ? "bun.stdout" : "bun.stderr", args: [value], type: DYN, loc };
  L.noLowering(`Bun.Subprocess.${name}`, expr, "only exited, pid, exitCode, killed, stdout and stderr reads are supported");
}
