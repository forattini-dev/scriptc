import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { BOOL, F64, STRING, VOID, type IrExpr, type IrLibFn, type IrStmt, type IrType, type SrcLoc } from "../../ir/nodes.js";
import { varRef } from "../../ir/build.js";
import { fenceOrDropOptionKey, FS_WRITE_FILE_DOCUMENTED_OPTIONS } from "./surfaces.js";

function optionMember(p: ts.ObjectLiteralElementLike): { name: string; value: ts.Expression } | null {
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return { name: p.name.text, value: p.initializer };
  if (ts.isShorthandPropertyAssignment(p) && ts.isIdentifier(p.name)) return { name: p.name.text, value: p.name };
  return null;
}

/** Literal whole-file write options. Stage arguments and option values in
 * source order, before the runtime opens or writes any file. */
export function lowerFsWriteOptions(
  L: Lowerer, expr: ts.CallExpression, bi: { module: string; member: string }, loc: SrcLoc,
): IrExpr | null {
  // writeFileSync, fs.promises.writeFile and appendFileSync share literal
  // string-data options. The mode is open(2)'s creation-only argument;
  // an existing file retains its permissions. Buffer options remain fenced.
  const syncWriteOptions = bi.module === "fs" && bi.member === "writeFileSync";
  const promiseWriteOptions = bi.module === "fs/promises" && bi.member === "writeFile";
  const appendOptions = bi.module === "fs" && bi.member === "appendFileSync";
  if ((syncWriteOptions || promiseWriteOptions || appendOptions) && expr.arguments.length === 3) {
    const optsNode = expr.arguments[2]!;
    const operation = promiseWriteOptions ? "fs.promises.writeFile" : bi.member;
    const plainFn: IrLibFn = promiseWriteOptions ? "fsp.writeFile" : appendOptions ? "fs.appendFileSync" : "fs.writeFileSync";
    const modeFn: IrLibFn = promiseWriteOptions ? "fsp.writeFileMode" : "fs.writeFileModeSync";
    const exclusiveModeFn: IrLibFn = promiseWriteOptions
      ? "fsp.writeFileExclusiveMode"
      : "fs.writeFileExclusiveModeSync";
    const resultType: IrType = promiseWriteOptions ? { kind: "promise", inner: VOID } : VOID;
    type WriteOptionValue = { kind: "effect" | "mode"; value: IrExpr };
    let exclusive = false;
    // The runtime needs only `mode`, but every source option value is an
    // ordinary JS expression. Stage path/data and then evaluate the option
    // values in object-literal order before issuing the write; otherwise a
    // call/getter statically typed as the accepted utf8 literal can vanish.
    const finishWrite = (optionValues: WriteOptionValue[]): IrExpr => {
      const path = L.lowerExprExpecting(expr.arguments[0]!, STRING);
      const data = L.lowerExprExpecting(expr.arguments[1]!, STRING);
      const pathLocal = L.declareHiddenLocal("%writePath", STRING);
      const dataLocal = L.declareHiddenLocal("%writeData", STRING);
      const stmts: IrStmt[] = [
        { kind: "varDecl", localId: pathLocal.id, init: path, loc: path.loc },
        { kind: "varDecl", localId: dataLocal.id, init: data, loc: data.loc },
      ];
      let mode: IrExpr | null = null;
      for (const option of optionValues) {
        if (option.kind === "effect") {
          stmts.push({ kind: "exprStmt", expr: option.value, loc: option.value.loc });
          continue;
        }
        const modeLocal = L.declareHiddenLocal("%writeMode", F64);
        stmts.push({ kind: "varDecl", localId: modeLocal.id, init: option.value, loc: option.value.loc });
        mode = varRef(modeLocal.id, modeLocal.type, loc);
      }
      const writeMode = mode ?? (exclusive
        ? { kind: "numLit", value: 0o666, type: F64, loc } satisfies IrExpr
        : null);
      const result: IrExpr = {
        kind: "libCall",
        fn: appendOptions && writeMode ? "fs.appendFileModeSync" : exclusive ? exclusiveModeFn : writeMode ? modeFn : plainFn,
        args: writeMode
          ? [varRef(pathLocal.id, pathLocal.type, loc), varRef(dataLocal.id, dataLocal.type, loc), writeMode]
          : [varRef(pathLocal.id, pathLocal.type, loc), varRef(dataLocal.id, dataLocal.type, loc)],
        type: resultType,
        loc,
      };
      if (appendOptions && writeMode) result.args.push({ kind: "boolLit", value: exclusive, type: BOOL, loc });
      return { kind: "seqExpr", stmts, result, type: resultType, loc };
    };
    // The bare-encoding spelling — writeFileSync(p, data, "utf-8") — is
    // the options record's encoding key alone: utf8 is what the runtime
    // writes anyway, so string data takes the plain write. Any OTHER
    // encoding name changes bytes and keeps the fence below.
    {
      const t = L.typeOf(optsNode);
      if (
        t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8") &&
        L.mapTypeOf(L.typeOf(expr.arguments[1]!))?.kind === "string"
      ) {
        return finishWrite([{ kind: "effect", value: L.lowerExprExpecting(optsNode, STRING) }]);
      }
    }
    const optionValues: WriteOptionValue[] = [];
    let ok = ts.isObjectLiteralExpression(optsNode);
    if (ok) {
      for (const p of (optsNode as ts.ObjectLiteralExpression).properties) {
        const m = optionMember(p);
        if (!m) { ok = false; break; }
        if (m.name === "mode") {
          optionValues.push({ kind: "mode", value: L.lowerExprExpecting(m.value, F64) });
        } else if (m.name === "encoding") {
          const t = L.typeOf(m.value);
          if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) { ok = false; break; }
          optionValues.push({ kind: "effect", value: L.lowerExprExpecting(m.value, STRING) });
        } else if (m.name === "flag") {
          const t = L.typeOf(m.value);
          if (!t.isStringLiteralType() || (appendOptions ? t.value !== "a" && t.value !== "ax" : t.value !== "wx")) {
            L.noLowering(
              `${operation} with the flag option`,
              p,
              appendOptions ? "the supported flags are append 'a' and exclusive append 'ax'" : "the supported flags are Node's default 'w' and exclusive-create 'wx'",
            );
          }
          optionValues.push({ kind: "effect", value: L.lowerExprExpecting(m.value, STRING) });
          exclusive = t.value === (appendOptions ? "ax" : "wx");
        } else {
          // The options-record stance: documented keys with no lowering
          // fence by name; undocumented keys drop like Node.
          fenceOrDropOptionKey(
            L, p, m.name, operation, FS_WRITE_FILE_DOCUMENTED_OPTIONS,
            `the supported options are { mode: <number>, encoding: "utf8", flag: "${appendOptions ? "a" : "wx"}" }`,
          );
        }
      }
    }
    if (!ok || L.mapTypeOf(L.typeOf(expr.arguments[1]!))?.kind !== "string") {
      L.noLowering(
        `${operation} with 3 arguments`,
        optsNode,
        `the supported options are { mode: <number>, encoding: "utf8", flag: "${appendOptions ? "a" : "wx"}" } over string data`,
      );
    }
    return finishWrite(optionValues);
  }
  return null;
}
