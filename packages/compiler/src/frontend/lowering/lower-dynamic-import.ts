import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { JSVAL, STRING, type IrExpr } from "../../ir/ir.js";
import { InternalCompilerError } from "../../errors.js";
import { type Lowerer, PoisonError } from "./lowerer.js";
import { lowerJsonDynamicImport, lowerOwnModuleImport } from "./lower-island.js";
import { lowerNativeImportCall } from "./lower-native-import.js";

  export function lowerDynamicImportCall(L: Lowerer, call: ts.CallExpression): IrExpr | null {
    if (call.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
    const json = lowerJsonDynamicImport(L, call);
    if (json !== null) return json;
    const native = lowerNativeImportCall(L, call);
    if (native !== null) return native;
    L.requireDynamicApi("'import()'", call);
    const loc = locOf(call);
    const arg = call.arguments[0];
    if (call.arguments.length !== 1) {
      L.unsupported("SC1090", call, "dynamic import() with import attributes");
    }
    if (arg === undefined) {
      L.unsupported("SC1090", call, "dynamic import() without a specifier");
    }
    if (!ts.isStringLiteralLike(arg)) {
      const specifier = L.lowerExpr(arg);
      if (specifier.type.kind !== "string") {
        L.unsupported(
          "SC1090",
          arg,
          "dynamic import() of a computed value that is not statically a string",
        );
      }
      const raw: IrExpr = {
        kind: "libCall",
        fn: "island.importDynPath",
        args: [specifier],
        type: JSVAL,
        loc,
      };
      return { kind: "jsBridgePromise", value: raw, type: { kind: "promise", inner: JSVAL }, loc };
    }
    const res = L.dynImports.get(`${call.getSourceFile().fileName}\u0000${arg.text}`);
    if (!res) {
      // Collection walks every file before bodies lower, so a missing
      // entry is a lowerer bug, not user error.
      throw new InternalCompilerError(`lowerer bug: unresolved dynamic import '${arg.text}'`);
    }
    if (res.kind === "program-module") {
      return lowerOwnModuleImport(L, call, arg);
    }
    if (res.kind !== "module") {
      throw new PoisonError(); // resolution failed — collection reported it
    }
    const raw: IrExpr = {
      kind: "libCall",
      fn: "island.importDyn",
      args: [{ kind: "strLit", value: res.key, type: STRING, loc }],
      type: JSVAL,
      loc,
    };
    return { kind: "jsBridgePromise", value: raw, type: { kind: "promise", inner: JSVAL }, loc };
  }
