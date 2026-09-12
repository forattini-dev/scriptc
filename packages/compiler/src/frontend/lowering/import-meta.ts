import * as ts from "../ts7/adapter.js";
import { dirname, posix } from "node:path";
import { pathToFileURL } from "node:url";
import type { Lowerer } from "./lowerer.js";
import { wasiGuestPath } from "../../wasi-paths.js";
import { BOOL, IrExpr, STRING } from "../../ir/ir.js";
import { locOf } from "../program.js";

export function moduleFileName(lowerer: Lowerer, sf: ts.SourceFile): string {
    return lowerer.targetPlatform === "wasi"
      ? wasiGuestPath(sf.fileName) ?? sf.fileName.replace(/\\/g, "/")
      : sf.fileName;
  }

export function importMetaProperty(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
    if (expr.questionDotToken !== undefined || !ts.isMetaProperty(expr.expression)) return null;
    const meta = expr.expression;
    if (meta.keywordToken !== ts.SyntaxKind.ImportKeyword || meta.name.text !== "meta") return null;

    const sf = expr.getSourceFile();
    const fileName = moduleFileName(lowerer, sf);
    // Enabling islands does not move this typed expression into an engine.
    // Its source module is known, so direct metadata reads still lower natively.
    switch (expr.name.text) {
      case "url":
        return {
          kind: "strLit",
          value: pathToFileURL(fileName, { windows: lowerer.targetPlatform === "win32" }).href,
          type: STRING,
          loc: locOf(expr),
        };
      case "filename":
        return { kind: "strLit", value: fileName, type: STRING, loc: locOf(expr) };
      case "dirname":
        return {
          kind: "strLit",
          value: lowerer.targetPlatform === "wasi" ? posix.dirname(fileName) : dirname(fileName),
          type: STRING,
          loc: locOf(expr),
        };
      case "main":
        return { kind: "boolLit", value: sf === lowerer.entry, type: BOOL, loc: locOf(expr) };
      default:
        lowerer.unsupported(
          "SC1090",
          expr,
          `'import.meta.${expr.name.text}' (only url, filename, dirname, and main are supported in static ESM)`,
        );
        return null;
    }
  }
