/* Kernel package recognition shared by the type mapper and the lowering:
 * which program declarations the native kernels serve. */
import * as ts from "./ts7/adapter.js";

const EFFECT_DIST = /[\\/]node_modules[\\/]effect[\\/]dist[\\/]([A-Za-z]+)\.d\.ts$/;

/** The effect namespace (`Context`, `Effect`, …) an expression names, by the provenance of its alias target. */
export function effectNamespaceOfNode(checker: ts.TypeChecker, node: ts.Expression): string | null {
  if (!ts.isIdentifier(node)) return null;
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return null;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  for (const decl of checker.declarationsOf(symbol)) {
    if (!ts.isSourceFile(decl)) continue;
    const match = EFFECT_DIST.exec(decl.fileName);
    if (match) return match[1]!;
  }
  return null;
}

/** `class Service extends Context.Service<Self, Shape>()("id") {}` — a kernel SERVICE KEY declaration: the class is the
 * key (an effect that looks the service up), never a runtime class. Answers the id, or null for any other class. */
export function kernelServiceIdOf(checker: ts.TypeChecker, decl: ts.ClassLikeDeclaration): string | null {
  const heritage = decl.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
  if (heritage === undefined) return null;
  const outer = heritage.expression;
  if (!ts.isCallExpression(outer) || outer.arguments.length !== 1 || !ts.isStringLiteral(outer.arguments[0]!)) return null;
  const inner = outer.expression;
  if (!ts.isCallExpression(inner) || inner.arguments.length !== 0) return null;
  const member = inner.expression;
  if (!ts.isPropertyAccessExpression(member) || !ts.isIdentifier(member.name) || member.name.text !== "Service") return null;
  return effectNamespaceOfNode(checker, member.expression) === "Context" ? outer.arguments[0]!.text : null;
}

/** The kernel service id a VALUE symbol names (the class, through import aliases), or null. */
export function kernelServiceIdOfSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): string | null {
  if (symbol === undefined) return null;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  const decl = checker.valueDeclarationOf(symbol);
  return decl !== undefined && ts.isClassDeclaration(decl) ? kernelServiceIdOf(checker, decl) : null;
}

/** A SCHEMA CLASS declaration the kernel serves natively: `class X extends Schema.Class<X>("id")({…})`,
 * `Schema.ErrorClass<X>("id")({…})`, `Schema.TaggedClass<X>()("tag", {…})`, `Schema.TaggedErrorClass<X>()("tag", {…})`.
 * The fields literal names the props; the checker types them. Error forms carry the runtime Error base. */
export interface KernelSchemaClass {
  form: "class" | "error" | "taggedClass" | "taggedError";
  /** The `_tag` literal (tagged forms) — also the Error `.name`. */
  tag: string | null;
  /** The identifier (untagged forms; the Error `.name` of ErrorClass). */
  identifier: string;
  fields: ts.ObjectLiteralExpression;
}

export function kernelSchemaClassOf(checker: ts.TypeChecker, decl: ts.ClassLikeDeclaration): KernelSchemaClass | null {
  const heritage = decl.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
  if (heritage === undefined) return null;
  const outer = heritage.expression;
  if (!ts.isCallExpression(outer) || !ts.isCallExpression(outer.expression)) return null;
  const inner = outer.expression;
  const member = inner.expression;
  if (!ts.isPropertyAccessExpression(member) || !ts.isIdentifier(member.name)) return null;
  if (effectNamespaceOfNode(checker, member.expression) !== "Schema") return null;
  const name = member.name.text;
  const fields = outer.arguments[outer.arguments.length - 1];
  if (fields === undefined || !ts.isObjectLiteralExpression(fields)) return null;
  if (name === "Class" || name === "ErrorClass") {
    const id = inner.arguments[0];
    if (inner.arguments.length !== 1 || id === undefined || !ts.isStringLiteral(id) || outer.arguments.length !== 1) return null;
    return { form: name === "Class" ? "class" : "error", tag: null, identifier: id.text, fields };
  }
  if (name === "TaggedClass" || name === "TaggedErrorClass") {
    const id = inner.arguments[0];
    if (inner.arguments.length > 1 || (id !== undefined && !ts.isStringLiteral(id))) return null;
    const tag = outer.arguments[0];
    if (outer.arguments.length !== 2 || tag === undefined || !ts.isStringLiteral(tag)) return null;
    return { form: name === "TaggedClass" ? "taggedClass" : "taggedError", tag: tag.text, identifier: id?.text ?? tag.text, fields };
  }
  return null;
}

const SCHEMA_DIST = /[\\/]node_modules[\\/]effect[\\/]dist[\\/](Schema|SchemaAST|SchemaIssue|SchemaGetter|SchemaTransformation|SchemaCheck|SchemaParser|internal[\\/]schema[\\/][A-Za-z]+)\.d\.ts$/;

/** A Schema VALUE type — the interfaces and classes of effect's Schema modules (`Struct<…>`, `String`, `optional<…>`,
 * a Filter, SchemaError): the kernel's opaque handle in a static build. Type aliases (`Struct.Type<F>`) stay structural. */
export function isKernelSchemaValueSymbol(decls: readonly ts.Node[]): boolean {
  // `Struct` merges a function, an interface and a namespace: every declaration lives in a Schema module and at least
  // one is the interface/class that types the VALUE.
  return decls.length > 0 && decls.every((d) => SCHEMA_DIST.test(d.getSourceFile().fileName)) && decls.some((d) => ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d));
}

const BRAND_DIST = /[\\/]node_modules[\\/]effect[\\/]dist[\\/]Brand\.d\.ts$/;

/** The parts of an intersection that are NOT effect's `Brand<…>` marker (`string & Brand<"ID">` is a string at
 * runtime; the brand is type-level only). */
export function withoutKernelBrands(checker: ts.TypeChecker, parts: readonly ts.Type[]): readonly ts.Type[] {
  return parts.filter((part) => {
    const sym = part.getAliasSymbol() ?? part.getSymbol();
    const decls = sym === undefined ? [] : checker.declarationsOf(sym);
    return !(decls.length > 0 && decls.every((d) => BRAND_DIST.test(d.getSourceFile().fileName)));
  });
}
