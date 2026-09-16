/* Runtime-optional values: a binding whose type carries an undefined arm because a READ may observe absence (a
 * sparse array element, an index-signature miss, an optional parameter promoted through its callers). The prepass
 * decides which locals, globals, fields, parameters and returns are promoted; the reads and writes below answer with
 * the promoted type, the present-value union, and the record-field rewrites the lowering needs. The branch-flow
 * proofs live in lower-runtime-optional-branches.ts and the dense-array reads in lower-dense-array-reads.ts. */
import * as ts from "../ts7/adapter.js";
import type { IrExpr, IrGlobal, IrLocal, IrType } from "../../ir/ir.js";
import { BOOL, DYN, F64, isUnitType, STRING, typeEquals, UNDEFINED_T } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { FileParts, declSymbolOf } from "./lower-modules.js";
import { ParamShape, FnSig } from "./lower-calls.js";
import { varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import { boundIdentifiersOf, nodeThrowExpr } from "./lowerer.js";

export function runtimeOptionalRootOf(lowerer: Lowerer, local: IrLocal): IrLocal {
  return lowerer.runtimeOptionalRoots.get(local) ?? local;
}

export function runtimeOptionalBindingType(lowerer: Lowerer, node: ts.Node): IrType | null;
export function runtimeOptionalBindingType(lowerer: Lowerer, node: ts.Node, fallback: IrType): IrType;
/** The forwarding form, for the Lowerer's own overloads to delegate through. */
export function runtimeOptionalBindingType(lowerer: Lowerer, node: ts.Node, fallback?: IrType): IrType | null;
export function runtimeOptionalBindingType(lowerer: Lowerer, node: ts.Node, fallback?: IrType): IrType | null {
  const patternType = lowerer.runtimeOptionalPatternTypes.get(node);
  if (patternType) return patternType;
  const symbol = ts.isIdentifier(node) ? lowerer.resolveValueSymbol(node) : lowerer.checker.getSymbolAtLocation(node);
  if (!symbol) return fallback ?? null;
  const known = lowerer.runtimeOptionalBindingTypes.get(symbol);
  if (known) return known;
  // A module-scope function alias is collected as a global before the
  // optional-read fixed point settles. Derive its promoted function ABI
  // directly from the aliased declaration as a final read-side hook, so
  // the initializer cannot fall back to a narrowing adapter.
  if (ts.isIdentifier(node) && fallback?.kind === "func") {
    const decl = lowerer.checker.valueDeclarationOf(symbol);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isIdentifier(init)) {
        const source = lowerer.resolveValueSymbol(init);
        const sig = source ? lowerer.fnSigsBySymbol.get(source) : undefined;
        if (sig) {
          return {
            ...fallback,
            params: sig.params.filter((p) => p.mode !== "dynRest").map((p) => p.type),
            ret: sig.returnType,
          };
        }
      }
    }
  }
  return fallback ?? null;
}

export function runtimeOptionalIdentifierValue(lowerer: Lowerer, node: ts.Expression): { value: IrExpr; present: IrType; unionId: string } | null {
  if (!ts.isIdentifier(node) || lowerer.chainRecvByNode.has(node)) return null;
  const local = lowerer.resolveLocal(node);
  const symbol = lowerer.resolveValueSymbol(node);
  const storage = local ?? (symbol ? lowerer.globalsBySymbol.get(symbol) : undefined);
  if (!storage || storage.type.kind !== "union" || lowerer.armTag(storage.type.unionId, UNDEFINED_T) < 0) return null;
  const present = lowerer.stripUndefinedArm(storage.type);
  if (isUnitType(present)) return null;
  return { value: varRef(storage.id, storage.type, locOf(node)), present, unionId: storage.type.unionId };
}

/** Recover the original optional union when a checked single-arm helper
 * was installed before a strict property consumer could name its member.
 * Recovery is limited to array element reads and storage roots marked by
 * the optional-read analysis, so ordinary assertions keep their generic
 * checked-narrow behavior. */
export function runtimeOptionalSourceValue(lowerer: Lowerer, node: ts.Expression, value: IrExpr): IrExpr | null {
  let origin: ts.Expression = node;
  while (ts.isParenthesizedExpression(origin)) origin = origin.expression;
  let optionalOrigin = ts.isElementAccessExpression(origin);
  if (ts.isIdentifier(origin)) {
    const local = lowerer.resolveLocal(origin);
    const root = local ? lowerer.runtimeOptionalRootOf(local) : null;
    const global = lowerer.globalOf(origin);
    optionalOrigin =
      (!!root && lowerer.runtimeOptionalStorageLocals.has(root)) ||
      (!!global && (lowerer.isRuntimeOptionalGlobal(global) ||
        (global.type.kind === "union" && lowerer.armTag(global.type.unionId, UNDEFINED_T) >= 0)));
  }
  if (!optionalOrigin) return null;

  let source = value;
  if (
    value.kind === "call" &&
    lowerer.checkedNarrowHelpers.has(value.callee) &&
    value.args.length === 1 &&
    value.args[0]?.type.kind === "union"
  ) {
    source = value.args[0];
  }
  return source.type.kind === "union" && lowerer.armTag(source.type.unionId, UNDEFINED_T) >= 0
    ? source
    : null;
}

/** A strict property or method receiver over an array-derived optional
 * value. Stabilize the receiver once, throw Node's member-read TypeError
 * for a unit arm, and extract the expected present arm otherwise. */
export function runtimeOptionalPropertyReceiver(lowerer: Lowerer, node: ts.Expression, value: IrExpr, expected: IrType, member: string): IrExpr | null {
  const source = lowerer.runtimeOptionalSourceValue(node, value);
  if (source?.type.kind !== "union") return null;
  const def = lowerer.unions.get(source.type.unionId);
  const valueTag = lowerer.armTag(source.type.unionId, expected);
  if (
    !def ||
    valueTag < 0 ||
    !def.arms.every((arm) => typeEquals(arm, expected) || isUnitType(arm))
  ) return null;

  const loc = locOf(node);
  const stable = lowerer.declareHiddenLocal("%propertyRecv", source.type);
  const stableRef = (): IrExpr => varRef(stable.id, source.type, loc);
  let result: IrExpr = {
    kind: "unionNarrow",
    unionId: source.type.unionId,
    tag: valueTag,
    value: stableRef(),
    type: expected,
    loc,
  };
  for (let i = def.arms.length - 1; i >= 0; i--) {
    const arm = def.arms[i];
    if (!arm || !isUnitType(arm)) continue;
    const unit = arm.kind === "nullT" ? "null" : "undefined";
    result = {
      kind: "ternary",
      cond: {
        kind: "unionIsTag",
        unionId: source.type.unionId,
        tag: i,
        negated: false,
        value: stableRef(),
        type: BOOL,
        loc,
      },
      then: nodeThrowExpr(1, "", `Cannot read properties of ${unit} (reading '${member}')`, expected, loc),
      else_: result,
      type: expected,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: stable.id, init: source, loc }],
    result,
    type: expected,
    loc,
  };
}

export function runtimeOptionalFieldKey(lowerer: Lowerer, shapeId: string, field: string): string {
  return `${shapeId}:${field}`;
}

export function isRuntimeOptionalField(lowerer: Lowerer, shapeId: string, field: string): boolean {
  return lowerer.runtimeOptionalFields.has(lowerer.runtimeOptionalFieldKey(shapeId, field));
}

export function isRuntimeOptionalGlobal(lowerer: Lowerer, global: IrGlobal): boolean {
  return lowerer.runtimeOptionalGlobals.has(global);
}

export function isRuntimeOptionalArithmeticGlobal(lowerer: Lowerer, global: IrGlobal): boolean {
  return lowerer.runtimeOptionalArithmeticGlobals.has(global);
}

/** The union produced when an unchecked array read reaches a typed slot
 * whose checker type is the corresponding bare arm. */
export function runtimeOptionalWidening(lowerer: Lowerer, actual: IrType, expected: IrType): IrType | null {
  if (actual.kind !== "union" || lowerer.armTag(actual.unionId, UNDEFINED_T) < 0) return null;
  return typeEquals(lowerer.stripUndefinedArm(actual), expected) ? actual : null;
}

export function runtimeOptionalType(lowerer: Lowerer, t: IrType): IrType {
  if (t.kind === "union") return lowerer.armTag(t.unionId, UNDEFINED_T) >= 0 ? t : lowerer.withUndefinedArmOf(t) ?? t;
  if (t.kind === "void" || t.kind === "dyn" || t.kind === "jsval" || t.kind === "generator") return t;
  return lowerer.withUndefinedArm(t);
}

export function promoteRuntimeOptionalParameter(lowerer: Lowerer, node: ts.Node, type: IrType): IrType {
  const widened = lowerer.runtimeOptionalType(type);
  const symbol = lowerer.checker.getSymbolAtLocation(node);
  if (symbol) lowerer.runtimeOptionalBindingTypes.set(symbol, widened);
  return widened;
}

export function promoteRuntimeOptionalFunctionReturn(lowerer: Lowerer, node: ts.Node, type: IrType): IrType {
  const widened = lowerer.runtimeOptionalType(type);
  lowerer.runtimeOptionalFunctionReturns.set(node, widened);
  return widened;
}

export function runtimeOptionalFunctionReturnType(lowerer: Lowerer, node: ts.Node, fallback: IrType): IrType {
  return lowerer.runtimeOptionalFunctionReturns.get(node) ?? fallback;
}

/** Promote one field of a record storage shape to the value's runtime
 * type. Shapes are immutable by identity, so this interns a sibling shape
 * and records the field as runtime-optional for property-read narrowing. */
export function runtimeOptionalRecordField(lowerer: Lowerer, type: IrType, field: string, fieldType: IrType): IrType {
  if (type.kind !== "record") return type;
  const shape = lowerer.shapes.get(type.shapeId);
  if (!shape) return type;
  const existing = shape.fields.find((f) => f.name === field);
  if (!existing || typeEquals(existing.type, fieldType)) {
    if (existing) lowerer.runtimeOptionalFields.add(lowerer.runtimeOptionalFieldKey(type.shapeId, field));
    return type;
  }
  const shapeId = lowerer.shapes.intern(
    shape.fields.map((f) => ({ name: f.name, type: f.name === field ? fieldType : f.type })),
    shape.tuple === true,
    shape.indexValue,
    shape.declaredOrder,
  );
  lowerer.runtimeOptionalFields.add(lowerer.runtimeOptionalFieldKey(shapeId, field));
  return { kind: "record", shapeId };
}

/** Discover the unchecked-array values that cross static ABI/storage
 * boundaries before any function body or module initializer is emitted.
 * TypeScript's default indexed-access type is a useful source annotation,
 * but it is not a runtime proof; promoting only the affected slots keeps
 * the rest of the dense ABI unchanged. */
export function analyzeRuntimeOptionalArrayReads(lowerer: Lowerer, parts: FileParts[]): void {
  const optionalSymbols = new Set<ts.Symbol>();
  const optionalReturns = new Set<ts.Symbol>();
  const arithmeticReturns = new Map<ts.Symbol, IrType>();
  const optionalParams = new Map<ts.Symbol, Set<number>>();
  const optionalFields = new Map<ts.Symbol, Set<string>>();
  const dynamicObjectEntryRows = new Set<ts.Symbol>();
  const sourceFiles = parts.map((p) => p.sf);
  const fnDecls = parts.flatMap((p) => p.fnDecls);
  // This fixed-point scan intentionally sees deferred bodies before
  // reachability is known. Batch their binding queries through the
  // facade's panic fence, then keep lookup free of lowering side effects:
  // resolveValueSymbol also flushes deferred diagnostics and applies
  // merged-namespace fences, whose authority remains ordinary lowering.
  lowerer.checker.prefetchSymbolRoots(sourceFiles);
  const symbolOf = (node: ts.Node): ts.Symbol | null => {
    const s = lowerer.checker.getSymbolAtLocation(node);
    if (!s) return null;
    return s.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(s) : s;
  };
  const functionDeclBySymbol = new Map<ts.Symbol, ts.FunctionLikeDeclaration>();
  type RuntimeSig = {
    params: ParamShape[];
    returnType: IrType;
    top?: FnSig;
    method?: { params: ParamShape[]; ret: IrType };
  };
  const signatureBySymbol = new Map<ts.Symbol, RuntimeSig>();
  for (const [symbol, sig] of lowerer.fnSigsBySymbol) signatureBySymbol.set(symbol, { params: sig.params, returnType: sig.returnType, top: sig });
  for (const decl of fnDecls) {
    const symbol = declSymbolOf(lowerer, decl);
    if (symbol) functionDeclBySymbol.set(symbol, decl);
  }
  for (const sf of sourceFiles) {
    ts.walkPreorder(sf, (node) => {
      if (
        (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
        node.body && node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      ) {
        const symbol = symbolOf(node.name);
        if (symbol) functionDeclBySymbol.set(symbol, node);
      }
    });
  }
  for (const info of lowerer.classes.values()) {
    for (const { mName, member } of lowerer.classMethodMembers(info)) {
      if (!member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) continue;
      const symbol = symbolOf(member.name);
      const sig = info.methods.get(mName);
      if (symbol && sig) signatureBySymbol.set(symbol, { params: sig.params, returnType: sig.ret, method: sig });
    }
  }
  const peel = (node: ts.Expression): ts.Expression => {
    let e = node;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertion(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
    }
    return e;
  };
  const explicitlyNonNull = (node: ts.Expression): boolean => {
    let e = node;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertion(e) || ts.isNonNullExpression(e)) {
      if (ts.isNonNullExpression(e)) return true;
      e = e.expression;
    }
    return false;
  };
  const isArrayRead = (node: ts.Expression): boolean => {
    const e = peel(node);
    if (!ts.isElementAccessExpression(e)) return false;
    return lowerer.mapTypeOf(lowerer.typeOf(e.expression))?.kind === "array";
  };
  const isDynamicObjectEntryRead = (node: ts.Expression): boolean => {
    const read = peel(node);
    if (!ts.isElementAccessExpression(read) || !ts.isIdentifier(read.expression)) return false;
    const source = symbolOf(read.expression);
    const declaration = source ? lowerer.checker.valueDeclarationOf(source) : undefined;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
    const init = peel(declaration.initializer);
    if (!ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression)) return false;
    if (init.expression.name.text !== "entries" || !lowerer.isStdlibGlobal(init.expression.expression, "Object")) return false;
    const object = init.arguments[0];
    const objectType = object ? lowerer.mapTypeOf(lowerer.typeOf(object)) : null;
    return objectType?.kind === "dyn" || objectType?.kind === "jsval";
  };
  const addUndefined = (t: IrType): IrType => {
    if (t.kind === "union") return lowerer.armTag(t.unionId, UNDEFINED_T) >= 0 ? t : lowerer.withUndefinedArmOf(t) ?? t;
    if (t.kind === "void" || t.kind === "dyn" || t.kind === "jsval" || t.kind === "generator") return t;
    return lowerer.withUndefinedArm(t);
  };
  const fieldName = (node: ts.PropertyAccessExpression): string => node.name.text;
  const mayBeOptional = (node: ts.Expression): boolean => {
    // `xs[i]!` is the explicit proven-present form. Its array read keeps
    // the established dense bounds trap and must not promote the enclosing
    // function/global ABI to `T | undefined`.
    if (explicitlyNonNull(node)) return false;
    const e = peel(node);
    if (isArrayRead(e)) return true;
    if (ts.isCallExpression(e) && lowerer.runtimeOptionalReduceTypes.has(e)) return true;
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      (e.expression.name.text === "pop" || e.expression.name.text === "shift") &&
      lowerer.mapTypeOf(lowerer.typeOf(e))?.kind === "union" &&
      lowerer.armTag((lowerer.mapTypeOf(lowerer.typeOf(e)) as IrType & { kind: "union" }).unionId, UNDEFINED_T) >= 0
    ) return true;
    if (ts.isIdentifier(e)) return optionalSymbols.has(symbolOf(e) ?? ({} as ts.Symbol));
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      return optionalReturns.has(symbolOf(e.expression) ?? ({} as ts.Symbol));
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      return optionalReturns.has(symbolOf(e.expression.name) ?? ({} as ts.Symbol));
    }
    if (ts.isConditionalExpression(e)) {
      return mayBeOptional(e.whenTrue) || mayBeOptional(e.whenFalse);
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) return mayBeOptional(e.left) || mayBeOptional(e.right);
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const fields = optionalFields.get(symbolOf(e.expression) ?? ({} as ts.Symbol));
      return fields?.has(fieldName(e)) ?? false;
    }
    return false;
  };
  const optionalStringArithmeticType = (node: ts.Expression): IrType | null => {
    const e = peel(node);
    if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null;
    const stringArrayRead = (part: ts.Expression): boolean => {
      const t = lowerer.mapTypeOf(lowerer.typeOf(part));
      const p = peel(part);
      if (t?.kind !== "string" || !ts.isElementAccessExpression(p)) return false;
      const recv = lowerer.mapTypeOf(lowerer.typeOf(p.expression));
      return recv?.kind === "array" && recv.elem.kind === "string";
    };
    const primitive = (part: ts.Expression): boolean => {
      const t = lowerer.mapTypeOf(lowerer.typeOf(part));
      return t?.kind === "f64" || t?.kind === "string";
    };
    if (!stringArrayRead(e.left) && !stringArrayRead(e.right)) return null;
    if (!(primitive(e.left) || stringArrayRead(e.left)) || !(primitive(e.right) || stringArrayRead(e.right))) return null;
    return { kind: "union", unionId: lowerer.unions.intern([F64, STRING]) };
  };
  const noteField = (decl: ts.VariableDeclaration, name: string): boolean => {
    if (!ts.isIdentifier(decl.name)) return false;
    const symbol = symbolOf(decl.name);
    if (!symbol) return false;
    return noteFieldSymbol(symbol, name);
  };
  const noteFieldSymbol = (symbol: ts.Symbol, name: string): boolean => {
    const set = optionalFields.get(symbol) ?? new Set<string>();
    const before = set.size;
    set.add(name);
    optionalFields.set(symbol, set);
    return set.size !== before;
  };
  const scanPattern = (name: ts.BindingName, init: ts.Expression): boolean => {
    if (!ts.isArrayBindingPattern(name)) return false;
    const sourceType = lowerer.mapTypeOf(lowerer.typeOf(init));
    if (sourceType?.kind !== "array") return false;
    let changed = false;
    name.elements.forEach((el) => {
      if (ts.isOmittedExpression(el) || el.name === undefined || el.dotDotDotToken) return;
      if (ts.isIdentifier(el.name)) {
        const symbol = symbolOf(el.name);
        if (symbol && !el.initializer && !optionalSymbols.has(symbol)) {
          optionalSymbols.add(symbol);
          // Indexed flow facts can survive a mutating method call in the
          // checker. The array's element ABI describes every value a
          // position may hold after that call, so bind from that type.
          const mapped = sourceType.elem;
          if (mapped && mapped.kind !== "void" && mapped.kind !== "dyn" && mapped.kind !== "jsval") {
            const widened = mapped.kind === "union" ? lowerer.withUndefinedArmOf(mapped) : lowerer.withUndefinedArm(mapped);
            if (widened) {
              lowerer.runtimeOptionalBindingTypes.set(symbol, widened);
              const global = lowerer.globalsBySymbol.get(symbol);
              if (global) {
                global.type = widened;
                lowerer.runtimeOptionalGlobals.add(global);
              }
            }
          }
          changed = true;
        }
      }
    });
    return changed;
  };
  const hofCallbackIndices = (name: string, hasInitialValue: boolean): number[] | null => {
    if (name === "reduce" || name === "reduceRight") return hasInitialValue ? [1] : [0, 1];
    if (
      name === "map" || name === "filter" || name === "forEach" ||
      name === "find" || name === "findIndex" || name === "findLast" ||
      name === "findLastIndex" || name === "some" || name === "every" ||
      name === "flatMap"
    ) return [0];
    return null;
  };
  const bodyReturnsOptional = (fn: ts.FunctionLikeDeclaration): boolean => {
    if (!fn.body) return false;
    if (!ts.isBlock(fn.body)) return mayBeOptional(fn.body as ts.Expression);
    let found = false;
    ts.walkPreorder(fn.body, (node) => {
      if (node !== fn.body && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))) return "skip";
      if (ts.isReturnStatement(node) && node.expression && mayBeOptional(node.expression)) found = true;
      return undefined;
    });
    return found;
  };
  const promoteHofCallback = (callback: ts.Expression, parameterIndices: readonly number[], seen = new Set<ts.Symbol>()): boolean => {
    let changed = false;
    const checkerTypeContainsTypeParameter = (type: ts.Type): boolean => {
      if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return true;
      return type.isUnionType() && ts.constituentTypes(type).some(checkerTypeContainsTypeParameter);
    };
    const promoteNode = (fn: ts.FunctionLikeDeclaration): void => {
      for (const parameterIndex of parameterIndices) {
        const parameter = fn.parameters[parameterIndex];
        if (!parameter) continue;
        const symbol = ts.isIdentifier(parameter.name) ? symbolOf(parameter.name) : null;
        const checkerType = lowerer.typeOf(parameter.name);
        const mapped = lowerer.mapTypeOf(checkerType);
        // Generic callbacks are monomorphized by their call-site binder.
        // During this prepass the type parameter has no static ABI yet;
        // asking irTypeOf to invent one poisons otherwise valid generic
        // value/HOF programs. Leave that parameter at its generic
        // signature and let the normal instantiation path specialize it.
        const current = mapped ??
          (checkerTypeContainsTypeParameter(checkerType) ? null : lowerer.irTypeOf(parameter.name));
        if (!current) continue;
        if (!ts.isIdentifier(parameter.name)) {
          const widened = lowerer.runtimeOptionalType(current);
          const previous = lowerer.runtimeOptionalPatternTypes.get(parameter.name);
          lowerer.runtimeOptionalPatternTypes.set(parameter.name, widened);
          if (!previous || !typeEquals(previous, widened)) changed = true;
        }
        if (symbol) {
          const widened = lowerer.runtimeOptionalType(current);
          const previous = lowerer.runtimeOptionalBindingTypes.get(symbol);
          lowerer.runtimeOptionalBindingTypes.set(symbol, widened);
          if (!previous || !typeEquals(previous, widened)) changed = true;
          if (!optionalSymbols.has(symbol)) {
            optionalSymbols.add(symbol);
            changed = true;
          }
        }
      }
      const fnType = lowerer.mapTypeOf(lowerer.typeOf(fn));
      if (fnType?.kind === "func" && bodyReturnsOptional(fn)) {
        const widenedReturn = lowerer.runtimeOptionalType(fnType.ret);
        const previousReturn = lowerer.runtimeOptionalFunctionReturnType(fn, fnType.ret);
        lowerer.runtimeOptionalFunctionReturns.set(fn, widenedReturn);
        if (!typeEquals(previousReturn, widenedReturn)) changed = true;
      }
    };
    if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback) || ts.isFunctionDeclaration(callback) || ts.isMethodDeclaration(callback)) {
      promoteNode(callback);
      return changed;
    }
    const callbackName = ts.isIdentifier(callback)
      ? callback
      : ts.isPropertyAccessExpression(callback)
        ? callback.name
        : null;
    if (!callbackName) return false;
    const symbol = symbolOf(callbackName);
    if (!symbol || seen.has(symbol)) return false;
    // Generic function values are pinned and monomorphized by the normal
    // contextual-value path when the HOF lowers its callback. Promoting
    // their type-parameter body here either asks for an impossible
    // monomorphic ABI or poisons valid generic value programs.
    if (lowerer.genericFnsBySymbol.has(symbol)) return false;
    seen.add(symbol);
    const declaration = lowerer.checker.valueDeclarationOf(symbol);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      if (promoteHofCallback(peel(declaration.initializer), parameterIndices, seen)) changed = true;
    }
    const sig = signatureBySymbol.get(symbol);
    if (sig) {
      for (const parameterIndex of parameterIndices) {
        if (!sig.params[parameterIndex]) continue;
        const before = sig.params[parameterIndex]!.type;
        sig.params[parameterIndex]!.type = lowerer.runtimeOptionalType(before);
        if (!typeEquals(before, sig.params[parameterIndex]!.type)) changed = true;
      }
    }
    const fn = functionDeclBySymbol.get(symbol);
    if (fn) promoteNode(fn);
    const valueType = lowerer.runtimeOptionalBindingTypes.get(symbol) ?? lowerer.mapTypeOf(lowerer.typeOf(callback));
    if (valueType?.kind === "func") {
      const params = valueType.params.slice();
      for (const parameterIndex of parameterIndices) {
        if (params[parameterIndex]) params[parameterIndex] = lowerer.runtimeOptionalType(params[parameterIndex]!);
      }
      const promoted: IrType = { ...valueType, params };
      const previous = lowerer.runtimeOptionalBindingTypes.get(symbol);
      lowerer.runtimeOptionalBindingTypes.set(symbol, promoted);
      if (!previous || !typeEquals(previous, promoted)) changed = true;
      const global = lowerer.globalsBySymbol.get(symbol);
      if (global) global.type = promoted;
      // A callback-typed parameter used by a native array HOF changes
      // the containing function's own call ABI. Record that edge in the
      // already-collected signature as well as on the body binding, so a
      // caller can promote the concrete callback value it supplies on a
      // later fixed-point pass (`wrapper(xs, predicate)` ->
      // `xs.some(predicate)`).
      if (declaration && ts.isParameter(declaration)) {
        const owner = declaration.parent;
        let ownerSymbol: ts.Symbol | null = null;
        if (ts.isFunctionDeclaration(owner)) ownerSymbol = declSymbolOf(lowerer, owner) ?? null;
        else if (
          (ts.isMethodDeclaration(owner) || ts.isGetAccessorDeclaration(owner) || ts.isSetAccessorDeclaration(owner)) &&
          owner.name
        ) ownerSymbol = symbolOf(owner.name);
        const ownerSig = ownerSymbol ? signatureBySymbol.get(ownerSymbol) : undefined;
        const ownerIndex = ts.isFunctionLike(owner) ? owner.parameters.indexOf(declaration) : -1;
        const slot = ownerIndex >= 0 ? ownerSig?.params[ownerIndex] : undefined;
        if (slot && !typeEquals(slot.type, promoted)) {
          slot.type = promoted;
          changed = true;
        }
      }
    }
    return changed;
  };
  const callbackReturnsOptional = (callback: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
    const node = peel(callback);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return bodyReturnsOptional(node);
    const symbol = symbolOf(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    const fn = functionDeclBySymbol.get(symbol);
    if (fn) return bodyReturnsOptional(fn);
    const decl = lowerer.checker.valueDeclarationOf(symbol);
    return !!decl && ts.isVariableDeclaration(decl) && !!decl.initializer && callbackReturnsOptional(decl.initializer, seen);
  };
  const scanFile = (sf: ts.SourceFile): boolean => {
    let changed = false;
    ts.walkPreorder(sf, (node) => {
      if (ts.isVariableDeclaration(node)) {
        if (node.initializer) {
          if (ts.isIdentifier(node.name) && isDynamicObjectEntryRead(node.initializer)) {
            const symbol = symbolOf(node.name);
            if (symbol && !dynamicObjectEntryRows.has(symbol)) {
              dynamicObjectEntryRows.add(symbol);
              changed = true;
            }
          } else if (ts.isIdentifier(node.name) && mayBeOptional(node.initializer)) {
            const symbol = symbolOf(node.name);
            if (symbol && !optionalSymbols.has(symbol)) {
              optionalSymbols.add(symbol);
              changed = true;
            }
          }
          if (ts.isIdentifier(node.name)) {
            const valueSymbol = ts.isIdentifier(peel(node.initializer))
              ? symbolOf(peel(node.initializer))
              : ts.isPropertyAccessExpression(peel(node.initializer))
                ? symbolOf((peel(node.initializer) as ts.PropertyAccessExpression).name)
                : null;
            const symbol = symbolOf(node.name);
            const sourceSig = valueSymbol ? signatureBySymbol.get(valueSymbol) : undefined;
            const sourceOptional =
              !!sourceSig &&
              (optionalReturns.has(valueSymbol!) ||
                (sourceSig.returnType.kind === "union" && lowerer.armTag(sourceSig.returnType.unionId, UNDEFINED_T) >= 0) ||
                sourceSig.params.some((p) => p.type.kind === "union" && lowerer.armTag(p.type.unionId, UNDEFINED_T) >= 0));
            if (symbol && valueSymbol && sourceOptional) {
              const aliasNew = !optionalReturns.has(symbol);
              if (aliasNew) optionalReturns.add(symbol);
              if (aliasNew) changed = true;
              const valueType = lowerer.mapTypeOf(lowerer.typeOf(node.name));
              if (valueType?.kind === "func" && sourceSig) {
                const promotedFn: IrType = {
                  ...valueType,
                  params: sourceSig.params.map((p) => p.type),
                  ret: sourceSig.returnType,
                };
                const previous = lowerer.runtimeOptionalBindingTypes.get(symbol);
                if (!previous || !typeEquals(previous, promotedFn)) {
                  lowerer.runtimeOptionalBindingTypes.set(symbol, promotedFn);
                  const global = lowerer.globalsBySymbol.get(symbol);
                  if (global) global.type = promotedFn;
                  changed = true;
                }
              }
            }
          }
          if (scanPattern(node.name, node.initializer)) changed = true;
          if (ts.isIdentifier(node.name) && ts.isObjectLiteralExpression(peel(node.initializer))) {
            const object = peel(node.initializer) as ts.ObjectLiteralExpression;
            for (const prop of object.properties) {
              if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
              const name = prop.name;
              if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) continue;
              const value = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name as ts.Expression;
              if (mayBeOptional(value) && noteField(node, name.text)) changed = true;
            }
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken) &&
        mayBeOptional(node.right)
      ) {
        if (ts.isIdentifier(node.left)) {
          const symbol = symbolOf(node.left);
          if (symbol && !optionalSymbols.has(symbol)) {
            optionalSymbols.add(symbol);
            changed = true;
          }
        } else if (ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)) {
          const symbol = symbolOf(node.left.expression);
          if (symbol && noteFieldSymbol(symbol, node.left.name.text)) changed = true;
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callbackIndices = hofCallbackIndices(node.expression.name.text, node.arguments.length >= 2);
        const receiverNode = node.expression.expression;
        const receiver = lowerer.mapTypeOf(lowerer.typeOf(receiverNode));
        const callback = callbackIndices === null ? undefined : node.arguments[0];
        const tuple = receiver?.kind === "record" && lowerer.shapes.get(receiver.shapeId)?.tuple === true;
        // A JS/evolving-any array may have acquired a precise FLOW type
        // at this call while its actual binding remains a checked-dynamic
        // array. Its callback consumes DYN values through runtime method
        // dispatch, so widening that callback to the native array value
        // ABI makes it impossible to box back into DYN. Judge a simple
        // binding by its declaration type, the same storage fact local
        // declaration lowering uses.
        let nativeArrayReceiver = receiver?.kind === "array" || tuple;
        if (nativeArrayReceiver && ts.isIdentifier(receiverNode)) {
          const receiverSymbol = symbolOf(receiverNode);
          const declaration = receiverSymbol ? lowerer.checker.valueDeclarationOf(receiverSymbol) : undefined;
          if (declaration && ts.isVariableDeclaration(declaration)) {
            const declared = lowerer.mapTypeOf(lowerer.typeOf(declaration.name));
            if (declared?.kind !== "array" && !(declared?.kind === "record" && lowerer.shapes.get(declared.shapeId)?.tuple === true)) {
              nativeArrayReceiver = false;
            }
          }
        }
        if (nativeArrayReceiver && callback && !ts.isSpreadElement(callback)) {
          if (promoteHofCallback(callback, callbackIndices!)) changed = true;
          const method = node.expression.name.text;
          if ((method === "reduce" || method === "reduceRight") &&
              (node.arguments.length < 2 || callbackReturnsOptional(callback))) {
            if (promoteHofCallback(callback, [0, 1])) changed = true;
            const result = lowerer.runtimeOptionalType(lowerer.irTypeOf(node));
            const previous = lowerer.runtimeOptionalReduceTypes.get(node);
            if (!previous || !typeEquals(previous, result)) {
              lowerer.runtimeOptionalReduceTypes.set(node, result);
              changed = true;
            }
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))
      ) {
        const calleeNode = ts.isIdentifier(node.expression) ? node.expression : node.expression.name;
        const symbol = symbolOf(calleeNode);
        if (!symbol) return;
        const sig = signatureBySymbol.get(symbol);
        if (!sig) {
          const decl = lowerer.checker.valueDeclarationOf(symbol);
          if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isIdentifier(decl.initializer)) {
            const source = symbolOf(decl.initializer);
            const sourceSig = source ? signatureBySymbol.get(source) : undefined;
            if (sourceSig) {
              node.arguments.forEach((arg, i) => {
                if (ts.isSpreadElement(arg) || !mayBeOptional(arg) || !sourceSig.params[i]) return;
                const before = sourceSig.params[i]!.type;
                sourceSig.params[i]!.type = lowerer.runtimeOptionalType(before);
                if (!typeEquals(before, sourceSig.params[i]!.type)) {
                  changed = true;
                  const sourceFn = functionDeclBySymbol.get(source!);
                  const parameter = sourceFn?.parameters[i];
                  if (parameter) {
                    for (const bound of boundIdentifiersOf(parameter.name)) {
                      const boundSymbol = symbolOf(bound);
                      if (boundSymbol && !optionalSymbols.has(boundSymbol)) {
                        optionalSymbols.add(boundSymbol);
                        changed = true;
                      }
                    }
                  }
                }
              });
            }
          }
          return;
        }
        node.arguments.forEach((arg, i) => {
            const callbackSlot = sig.params[i]?.type;
            if (callbackSlot?.kind === "func" && !ts.isSpreadElement(arg)) {
              const optionalCallbackParams = callbackSlot.params.flatMap((type, index) =>
                type.kind === "union" && lowerer.armTag(type.unionId, UNDEFINED_T) >= 0 ? [index] : []);
              if (optionalCallbackParams.length > 0 && promoteHofCallback(arg, optionalCallbackParams)) {
                changed = true;
              }
            }
            if (ts.isSpreadElement(arg) || !mayBeOptional(arg) || !sig.params[i]) return;
            const set = optionalParams.get(symbol) ?? new Set<number>();
            const before = set.size;
            set.add(i);
            optionalParams.set(symbol, set);
            if (set.size !== before) {
              changed = true;
              const callee = functionDeclBySymbol.get(symbol);
              const parameter = callee?.parameters[i];
              if (parameter) {
                for (const bound of boundIdentifiersOf(parameter.name)) {
                  const boundSymbol = symbolOf(bound);
                  if (boundSymbol && !optionalSymbols.has(boundSymbol)) {
                    optionalSymbols.add(boundSymbol);
                    changed = true;
                  }
                }
              }
            }
        });
      }
    });
    return changed;
  };
  const scanReturns = (symbol: ts.Symbol, decl: ts.FunctionLikeDeclaration): boolean => {
    if (!decl.body) return false;
    let changed = false;
    if (!ts.isBlock(decl.body) && mayBeOptional(decl.body as ts.Expression) && !optionalReturns.has(symbol)) {
      optionalReturns.add(symbol);
      changed = true;
    }
    if (!ts.isBlock(decl.body)) {
      const arithmetic = optionalStringArithmeticType(decl.body as ts.Expression);
      if (arithmetic && !arithmeticReturns.has(symbol)) {
        arithmeticReturns.set(symbol, arithmetic);
        changed = true;
      }
    }
    ts.walkPreorder(decl.body, (node) => {
      if (node !== decl.body && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))) return "skip";
      if (ts.isReturnStatement(node) && node.expression && mayBeOptional(node.expression) && !optionalReturns.has(symbol)) {
        optionalReturns.add(symbol);
        changed = true;
      }
      if (ts.isReturnStatement(node) && node.expression) {
        const arithmetic = optionalStringArithmeticType(node.expression);
        if (arithmetic && !arithmeticReturns.has(symbol)) {
          arithmeticReturns.set(symbol, arithmetic);
          changed = true;
        }
      }
      return undefined;
    });
    return changed;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const sf of sourceFiles) if (scanFile(sf)) changed = true;
    for (const [symbol, decl] of functionDeclBySymbol) if (scanReturns(symbol, decl)) changed = true;
  }
  for (const [symbol, sig] of signatureBySymbol) {
    const params = optionalParams.get(symbol);
    if (params) {
      for (const i of params) {
        const shape = sig.params[i];
        if (shape) shape.type = addUndefined(shape.type);
      }
    }
    if (optionalReturns.has(symbol)) {
      const next = sig.returnType.kind === "promise"
        ? { kind: "promise" as const, inner: addUndefined(sig.returnType.inner) }
        : addUndefined(sig.returnType);
      sig.returnType = next;
      if (sig.top) sig.top.returnType = next;
      if (sig.method) sig.method.ret = next;
    }
    const arithmetic = arithmeticReturns.get(symbol);
    if (arithmetic && sig.returnType.kind !== "promise") {
      sig.returnType = arithmetic;
      if (sig.top) sig.top.returnType = arithmetic;
      if (sig.method) sig.method.ret = arithmetic;
      const decl = functionDeclBySymbol.get(symbol);
      if (decl) lowerer.runtimeOptionalFunctionReturns.set(decl, arithmetic);
    }
  }
  for (const sf of sourceFiles) {
    ts.walkPreorder(sf, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
      const symbol = symbolOf(node.name);
      if (!symbol) return;
      const fields = optionalFields.get(symbol);
      if (!dynamicObjectEntryRows.has(symbol) && !optionalSymbols.has(symbol) && !fields) return;
      const current = lowerer.mapTypeOf(lowerer.typeOf(node.name));
      if (!current) return;
      let promoted = dynamicObjectEntryRows.has(symbol) ? DYN : current;
      if (!dynamicObjectEntryRows.has(symbol) && optionalSymbols.has(symbol)) promoted = addUndefined(promoted);
      if (promoted.kind === "func" && node.initializer && ts.isIdentifier(node.initializer)) {
        const sourceSig = lowerer.fnSigOf(node.initializer);
        if (sourceSig) {
          promoted = {
            ...promoted,
            params: sourceSig.params.filter((p) => p.mode !== "dynRest").map((p) => p.type),
            ret: sourceSig.returnType,
          };
        }
      }
      if (fields && promoted.kind === "record") {
        for (const field of fields) {
          const source = promoted.kind === "record"
            ? lowerer.shapes.get(promoted.shapeId)?.fields.find((f) => f.name === field)
            : undefined;
          if (!source) continue;
          promoted = lowerer.runtimeOptionalRecordField(promoted, field, addUndefined(source.type));
        }
      }
      if (!typeEquals(promoted, current)) {
        lowerer.runtimeOptionalBindingTypes.set(symbol, promoted);
        const global = ts.isIdentifier(node.name) ? lowerer.globalOf(node.name) : lowerer.globalsBySymbol.get(symbol);
        if (global) {
          global.type = promoted;
          lowerer.runtimeOptionalGlobals.add(global);
        }
      } else if (promoted.kind === "union" && lowerer.armTag(promoted.unionId, UNDEFINED_T) >= 0) {
        const global = ts.isIdentifier(node.name) ? lowerer.globalOf(node.name) : lowerer.globalsBySymbol.get(symbol);
        if (global) lowerer.runtimeOptionalGlobals.add(global);
      }
    });
  }
}
