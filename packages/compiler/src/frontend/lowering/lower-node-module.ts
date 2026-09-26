/* Engine-free CommonJS Module graph introspection. Module objects use the
 * process-lifetime f64-handle pattern (readline/diagnostics_channel): the
 * generated program defines immutable metadata once, while the runtime
 * registry tracks cache membership, parent/children, and loaded state as
 * require sites execute. */
import { posix, win32 } from "node:path";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { FileParts } from "./lower-modules.js";
import { isNodeEsmFile, locOf } from "../program.js";
import { runtimePathForTarget } from "../runtime-resolve.js";
import { BOOL, F64, IrExpr, IrStmt, IrType, NULL_T, STRING, UNDEFINED_T, VOID, arrayOf } from "../../ir/ir.js";
import { boolLit, numLit, strLit, varRef } from "../../ir/build.js";

const MODULE_FIELDS = new Set([
  "children", "filename", "id", "isPreloading", "loaded", "parent", "path", "paths", "require",
]);

function cjsGlobal(lowerer: Lowerer, node: ts.Expression, name: "module" | "require"): boolean {
  if (!ts.isIdentifier(node) || node.text !== name) return false;
  if (lowerer.isStdlibGlobal(node, name)) return true;
  const symbol = lowerer.checker.getSymbolAtLocation(node);
  const decls = symbol ? lowerer.checker.declarationsOf(symbol) : [];
  const sourceShadow = decls.some((decl) =>
    !decl.getSourceFile().isDeclarationFile &&
    (ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isBindingElement(decl) ||
      ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl) ||
      ts.isImportSpecifier(decl) || ts.isNamespaceImport(decl) || ts.isImportEqualsDeclaration(decl)),
  );
  return !sourceShadow && !isNodeEsmFile(node.getSourceFile());
}

function graphSyntax(lowerer: Lowerer, sf: ts.SourceFile): boolean {
  let found = false;
  ts.walkPreorder(sf, (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      if (cjsGlobal(lowerer, node.expression, "require") && (node.name.text === "main" || node.name.text === "cache")) {
        found = true;
        return "stop";
      }
      if (cjsGlobal(lowerer, node.expression, "module") && MODULE_FIELDS.has(node.name.text)) {
        found = true;
        return "stop";
      }
    }
    if (ts.isIdentifier(node) && cjsGlobal(lowerer, node, "module")) {
      const parent = node.parent;
      if (
        !ts.isPropertyAccessExpression(parent) || parent.expression !== node ||
        (parent.name.text !== "exports" && MODULE_FIELDS.has(parent.name.text))
      ) {
        found = true;
        return "stop";
      }
    }
    return undefined;
  });
  return found;
}

export function prepareCjsModuleGraph(lowerer: Lowerer, parts: readonly FileParts[]): void {
  lowerer.cjsModuleGraphEnabled = parts.some(({ sf }) => graphSyntax(lowerer, sf));
  if (!lowerer.cjsModuleGraphEnabled) return;
  for (const { sf } of parts) {
    if (sf.isDeclarationFile || sf.fileName.endsWith(".json") || isNodeEsmFile(sf)) continue;
    // Zero stays reserved so every module handle is truthy like the object
    // it represents, even when a value reaches a generic boolean context.
    const id = lowerer.cjsModuleFiles.length + 1;
    lowerer.cjsModuleFiles.push(sf);
    lowerer.cjsModuleIdOf.set(sf, id);
  }
}

function moduleFileName(lowerer: Lowerer, sf: ts.SourceFile): string {
  return runtimePathForTarget(sf.fileName, lowerer.targetPlatform);
}

function nodeModulePaths(fileName: string, targetPlatform: string): string[] {
  const api = targetPlatform === "win32" ? win32 : posix;
  const paths: string[] = [];
  let dir = api.dirname(fileName);
  for (;;) {
    if (api.basename(dir).toLowerCase() !== "node_modules") paths.push(api.join(dir, "node_modules"));
    const parent = api.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return paths;
}

export function cjsModuleRegistryPrelude(lowerer: Lowerer, loc: IrExpr["loc"]): IrStmt[] {
  if (!lowerer.cjsModuleGraphEnabled) return [];
  const body: IrStmt[] = [{
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "module.registryInit", args: [numLit(lowerer.cjsModuleFiles.length + 1, loc)], type: VOID, loc },
    loc,
  }];
  for (const [index, sf] of lowerer.cjsModuleFiles.entries()) {
    const moduleId = index + 1;
    const filename = moduleFileName(lowerer, sf);
    const isMain = sf === lowerer.entry && !isNodeEsmFile(lowerer.entry);
    const path = (lowerer.targetPlatform === "win32" ? win32 : posix).dirname(filename);
    const paths: IrExpr = {
      kind: "arrayLit",
      elems: nodeModulePaths(filename, lowerer.targetPlatform).map((value) => strLit(value, loc)),
      type: arrayOf(STRING),
      loc,
    };
    body.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "module.define",
        args: [numLit(moduleId, loc), strLit(filename, loc), strLit(isMain ? "." : filename, loc), strLit(path, loc), paths, boolLit(isMain, loc)],
        type: VOID,
        loc,
      },
      loc,
    });
  }
  return body;
}

export function cjsModuleRef(lowerer: Lowerer, node: ts.Node): IrExpr | null {
  const id = lowerer.cjsModuleIdOf.get(node.getSourceFile());
  return id === undefined ? null : numLit(id, locOf(node));
}

export function isCjsModuleGlobal(lowerer: Lowerer, node: ts.Expression): boolean {
  return cjsGlobal(lowerer, node, "module");
}

export function isNodeModuleValue(lowerer: Lowerer, node: ts.Expression): boolean {
  return isCjsModuleGlobal(lowerer, node) || nodeModuleType(lowerer, node);
}

export function isRequireCacheExpr(lowerer: Lowerer, node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "cache") return false;
  return cjsGlobal(lowerer, node.expression, "require");
}

function nodeModuleType(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.typeOf(node);
  const mapped = lowerer.mapTypeOf(type);
  const symbol = type.getSymbol();
  if (
    symbol && (symbol.name === "Module" || symbol.name === "ScriptcModule") &&
    lowerer.checker.declarationsOf(symbol).some((decl) => lowerer.isStdlibFile(decl.getSourceFile()))
  ) {
    return true;
  }
  const property = lowerer.checker.getPropertyOfType(type, "filename");
  const declaredByModule = property && lowerer.checker.declarationsOf(property).some((decl) => {
    for (let parent: ts.Node | undefined = decl.parent; parent; parent = parent.parent) {
      if (
        (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) &&
        parent.name && (parent.name.text === "ScriptcModule" || parent.name.text === "Module") &&
        lowerer.isStdlibFile(parent.getSourceFile())
      ) {
        return true;
      }
    }
    return false;
  });
  if (declaredByModule) return true;
  if (mapped?.kind !== "f64") return false;
  const rendered = lowerer.checker.typeToString(type);
  return rendered === "ScriptcModule" || rendered === "NodeModule" || rendered === "NodeJS.Module";
}

function optionalModule(
  lowerer: Lowerer,
  node: ts.Expression,
  raw: IrExpr,
  absent: "undefined" | "parent",
): IrExpr {
  const target = lowerer.irTypeOf(node);
  if (target.kind !== "union") return raw;
  const loc = locOf(node);
  const slot = lowerer.declareHiddenLocal("%module", F64);
  const ref = (): IrExpr => varRef(slot.id, F64, loc);
  const moduleValue = lowerer.coerceInto(node, ref(), target);
  const undefinedValue = lowerer.coerceInto(
    node,
    { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
    target,
  );
  const missing = absent === "undefined"
    ? undefinedValue
    : {
        kind: "ternary" as const,
        cond: { kind: "bin" as const, op: "===" as const, left: ref(), right: numLit(-1, loc), type: BOOL, loc },
        then: lowerer.coerceInto(node, { kind: "unitLit", unit: "null", type: NULL_T, loc }, target),
        else_: undefinedValue,
        type: target,
        loc,
      };
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: slot.id, init: raw, loc }],
    result: {
      kind: "ternary",
      cond: { kind: "bin", op: ">=", left: ref(), right: numLit(0, loc), type: BOOL, loc },
      then: moduleValue,
      else_: missing,
      type: target,
      loc,
    },
    type: target,
    loc,
  };
}

export function lowerRequireMainProperty(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (expr.questionDotToken || expr.name.text !== "main" || !cjsGlobal(lowerer, expr.expression, "require")) return null;
  const entryId = lowerer.cjsModuleIdOf.get(lowerer.entry);
  const raw = entryId === undefined ? numLit(-1, locOf(expr)) : numLit(entryId, locOf(expr));
  return lowerer.maybeNarrow(optionalModule(lowerer, expr, raw, "undefined"), expr);
}

export function lowerNodeModuleIdentifier(lowerer: Lowerer, expr: ts.Identifier): IrExpr | null {
  if (!isCjsModuleGlobal(lowerer, expr)) return null;
  const ref = cjsModuleRef(lowerer, expr);
  if (ref) return ref;
  lowerer.unsupported("SC1090", expr, "the CommonJS 'module' object in an ES module");
}

export function lowerNodeModuleProperty(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  const direct = isCjsModuleGlobal(lowerer, expr.expression);
  if (!direct && !nodeModuleType(lowerer, expr.expression)) return null;
  if (expr.questionDotToken) return null;
  const member = expr.name.text;
  if (member === "exports" || member === "require") return null;
  let moduleRef = direct ? cjsModuleRef(lowerer, expr.expression) : lowerer.lowerExpr(expr.expression);
  if (moduleRef?.type.kind === "union") {
    const present = lowerer.stripUndefinedArm(moduleRef.type);
    const helper = present.kind === "f64"
      ? lowerer.narrowedArmHelper(moduleRef.type.unionId, present, locOf(expr.expression))
      : null;
    if (helper) {
      moduleRef = { kind: "call", callee: helper, args: [moduleRef], type: F64, loc: locOf(expr.expression) };
    }
  }
  if (!moduleRef || moduleRef.type.kind !== "f64") return null;
  const loc = locOf(expr);
  const call = (fn: "module.filename" | "module.id" | "module.path" | "module.paths" | "module.children" | "module.parent" | "module.loaded", type: IrType): IrExpr =>
    ({ kind: "libCall", fn, args: [moduleRef], type, loc });
  switch (member) {
    case "filename":
      return call("module.filename", STRING);
    case "id":
      return call("module.id", STRING);
    case "path":
      return call("module.path", STRING);
    case "paths":
      return call("module.paths", arrayOf(STRING));
    case "children":
      return call("module.children", arrayOf(F64));
    case "loaded":
      return call("module.loaded", BOOL);
    case "isPreloading":
      return boolLit(false, loc);
    case "parent":
      return lowerer.maybeNarrow(optionalModule(lowerer, expr, call("module.parent", F64), "parent"), expr);
    default:
      lowerer.noLowering(
        `module.${member}`,
        expr,
        "the static CommonJS module surface is id, filename, path, paths, loaded, isPreloading, parent, children, exports, and require",
      );
  }
}

export function lowerRequireCacheElement(lowerer: Lowerer, expr: ts.ElementAccessExpression): IrExpr | null {
  if (expr.questionDotToken || !isRequireCacheExpr(lowerer, expr.expression)) return null;
  const key = lowerer.lowerExpr(expr.argumentExpression);
  if (key.type.kind !== "string") {
    lowerer.noLowering("require.cache lookup with a non-string key", expr.argumentExpression);
  }
  const raw: IrExpr = { kind: "libCall", fn: "module.cacheGet", args: [key], type: F64, loc: locOf(expr) };
  return lowerer.maybeNarrow(optionalModule(lowerer, expr, raw, "undefined"), expr);
}

export function lowerRequireCacheHas(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  if (expr.operatorToken.kind !== ts.SyntaxKind.InKeyword || !isRequireCacheExpr(lowerer, expr.right)) return null;
  const key = lowerer.lowerExpr(expr.left);
  if (key.type.kind !== "string") lowerer.noLowering("require.cache membership with a non-string key", expr.left);
  return { kind: "libCall", fn: "module.cacheHas", args: [key], type: BOOL, loc: locOf(expr) };
}

export function lowerRequireCacheKeys(lowerer: Lowerer, call: ts.CallExpression, member: string): IrExpr | null {
  const argument = call.arguments[0];
  if (member !== "keys" || call.arguments.length !== 1 || argument === undefined || !isRequireCacheExpr(lowerer, argument)) return null;
  return { kind: "libCall", fn: "module.cacheKeys", args: [], type: arrayOf(STRING), loc: locOf(call) };
}

function modulePropertyReceiver(lowerer: Lowerer, node: ts.Expression): boolean {
  return isNodeModuleValue(lowerer, node);
}

export function fenceNodeModuleMutation(
  lowerer: Lowerer,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  action: "assignment" | "delete",
): void {
  if (ts.isElementAccessExpression(target) && isRequireCacheExpr(lowerer, target.expression)) {
    lowerer.noLowering(
      `${action} through require.cache`,
      target,
      "a compiled binary has a fixed module graph; cache lookup and Object.keys(require.cache) are read-only",
    );
  }
  if (
    ts.isPropertyAccessExpression(target) && target.name.text !== "exports" &&
    modulePropertyReceiver(lowerer, target.expression)
  ) {
    lowerer.noLowering(
      `${action} to module.${target.name.text}`,
      target,
      "CommonJS module metadata is read-only in static builds; assign application state to a separate binding",
    );
  }
  if (
    ts.isElementAccessExpression(target) && ts.isPropertyAccessExpression(target.expression) &&
    target.expression.name.text === "paths" && modulePropertyReceiver(lowerer, target.expression.expression)
  ) {
    lowerer.noLowering(
      `${action} through module.paths`,
      target,
      "module.paths is introspection-only in a fixed compiled graph; configure resolution at build time",
    );
  }
}

export function fenceNodeModuleMutationCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (!ts.isPropertyAccessExpression(access.expression)) return null;
  const paths = access.expression;
  if (paths.name.text !== "paths" || !modulePropertyReceiver(lowerer, paths.expression)) return null;
  const mutators = new Set(["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"]);
  if (!mutators.has(access.name.text)) return null;
  lowerer.noLowering(
    `module.paths.${access.name.text}()`,
    call,
    "module.paths is introspection-only in a fixed compiled graph; configure resolution at build time",
  );
}
