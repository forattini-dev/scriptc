/* Kernel package recognition shared by the type mapper and the lowering:
 * which program declarations the native kernels serve. */
import * as ts from "./ts7/adapter.js";
import { constituentTypes } from "./ts7/checker.js";

const EFFECT_DIST = /[\\/]node_modules[\\/]effect[\\/]dist[\\/]([A-Za-z]+)\.d\.ts$/;
const EFFECT_UNSTABLE_DIST = /[\\/]node_modules[\\/]effect[\\/]dist[\\/]unstable[\\/]([a-z]+)[\\/]([A-Za-z]+)\.d\.ts$/;

/** The effect module a declaration file is: `Effect`, `Layer`, … for effect's top-level modules, `<area>/<Name>` for
 * its `unstable/<area>/<Name>` modules (`sql/SqlClient`, `reactivity/Reactivity`), so the two never collide. */
export function effectModuleOfFile(fileName: string): string | null {
  const match = EFFECT_DIST.exec(fileName);
  if (match) return match[1]!;
  const unstable = EFFECT_UNSTABLE_DIST.exec(fileName);
  return unstable ? `${unstable[1]!}/${unstable[2]!}` : null;
}

/** Native Effect declarations also contain structural records and callables. */
export function isKernelTypeFile(file: string): boolean {
  return /[\\/]node_modules[\\/]effect[\\/]dist[\\/]/.test(file);
}

/** The effect namespace (`Context`, `Effect`, …) an expression names, by the provenance of its alias target. */
export function effectNamespaceOfNode(checker: ts.TypeChecker, node: ts.Expression): string | null {
  if (!ts.isIdentifier(node)) return null;
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return null;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  for (const decl of checker.declarationsOf(symbol)) {
    if (!ts.isSourceFile(decl)) continue;
    const module = effectModuleOfFile(decl.fileName);
    if (module !== null) return module;
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
  // one is the interface/class that types the VALUE. A top-level lowercase type ALIAS (`toTaggedUnion<…>`, effect's
  // combinator-result naming) is a value type too; `Struct.Type<F>`-style aliases inside namespaces stay structural.
  if (decls.length === 0 || !decls.every((d) => SCHEMA_DIST.test(d.getSourceFile().fileName))) return false;
  return decls.some((d) => ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d) || (ts.isTypeAliasDeclaration(d) && ts.isSourceFile(d.parent) && /^[a-z]/.test(d.name.text)));
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

const EFFECT_DATA_DIST = /[\\/]effect[\\/]dist[\\/](Effect|Layer|Exit|Cause|Option)\.d\.ts$/;
const EFFECT_DATA_NAMES = new Set(["Effect", "Layer", "Exit", "Success", "Failure", "Cause", "Option", "Some", "None"]);

/** effect's core data types — Effect, Layer, Exit and its Success/Failure arms, Cause, Option and its Some/None arms —
 * declared as interfaces or type aliases in their dist modules: the kernel's opaque handle. */
export function isEffectDataHandleSymbol(symbol: ts.Symbol, decls: readonly ts.Node[]): boolean {
  return EFFECT_DATA_NAMES.has(symbol.name) &&
    decls.some((d) => (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)) && EFFECT_DATA_DIST.test(d.getSourceFile().fileName));
}

/** `Effect<…>` itself, from effect's dist Effect.d.ts (an Effect.gen body's yield channel). */
export function isEffectType(checker: ts.TypeChecker, type: ts.Type): boolean {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  return symbol?.name === "Effect" &&
    checker.declarationsOf(symbol).some((d) => ts.isInterfaceDeclaration(d) && /[\\/]effect[\\/]dist[\\/]Effect\.d\.ts$/.test(d.getSourceFile().fileName));
}

const SQL_CLIENT_DIST =/[\\/]node_modules[\\/]effect[\\/]dist[\\/]unstable[\\/]sql[\\/]SqlClient\.d\.ts$/;

/** A native effect/unstable/sql client type: effect's `SqlClient` interface, a program interface extending it (Redcode's
 * `interface SqliteClient extends Client.SqlClient`), or an intersection with one (`Object.assign(client, extras)`). */
export function isNativeSqlClientType(checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean {
  if (depth > 8) return false;
  if ((type.flags & ts.TypeFlags.Intersection) !== 0) return constituentTypes(type).some((part) => isNativeSqlClientType(checker, part, depth + 1));
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  return symbol !== undefined && isSqlClientSymbol(checker, symbol, depth);
}

function isSqlClientSymbol(checker: ts.TypeChecker, symbol: ts.Symbol, depth: number): boolean {
  if (depth > 8) return false;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return checker.declarationsOf(symbol).some((decl) => {
    if (!ts.isInterfaceDeclaration(decl)) return false;
    if (decl.name.text === "SqlClient" && SQL_CLIENT_DIST.test(decl.getSourceFile().fileName)) return true;
    return (decl.heritageClauses ?? []).some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.some((heritage) => {
      const expr = heritage.expression;
      const name = ts.isIdentifier(expr) ? expr : ts.isPropertyAccessExpression(expr) ? expr.name : undefined;
      const base = name === undefined ? undefined : checker.getSymbolAtLocation(name);
      return base !== undefined && isSqlClientSymbol(checker, base, depth + 1);
    }));
  });
}

const HANDLE_DIST =/[\\/]node_modules[\\/]effect[\\/]dist[\\/](?:unstable[\\/][a-z]+[\\/])?(Effect|Layer|Exit|Cause|Option|Context|Scope|Fiber|Deferred|Ref|SynchronizedRef|Queue|PubSub|Stream|Sink|Channel|Duration|DateTime|Config|ConfigProvider|Schedule|Semaphore|Latch|ManagedRuntime|Clock|Random|Logger|Tracer|Metric|ScopedCache|Cache|RcMap|RcRef|LayerMap|FiberSet|FiberMap|FiberHandle|Mailbox|Result|Redacted|Encoding|Match|Runtime|Scheduler|Supervisor|TxRef|Micro|Console|Path|FileSystem|HttpClient|HttpClientRequest|HttpClientResponse|Socket|Terminal|Command|CommandExecutor|Worker|KeyValueStore|PlatformError|Url|UrlParams|Headers|Cookies|HttpApi[A-Za-z]*|Http[A-Za-z]*|Rpc[A-Za-z]*|SqlClient|Statement|Reactivity|SqlError)\.d\.ts$/;

/** An OPAQUE effect value type — the interfaces/classes of effect's runtime modules (Effect, Layer, Cause, Scope, Fiber,
 * Deferred, Queue, Stream, Duration, Config, …): the kernel's handle in a static build. Type utilities (Types, Brand,
 * Pipeable, Data, Struct, Array, …) stay structural; aliases resolve structurally too. */
export function isKernelHandleSymbol(decls: readonly ts.Node[]): boolean {
  // File.Info is metadata returned by stat, not an executable kernel handle.
  // Preserve its full structural record, including native Option/Date/Size
  // fields. The declaration path and namespace distinguish it from an Info
  // interface owned by a different runtime contract.
  if (decls.length > 0 && decls.every(d => {
    if (!/[\\/]node_modules[\\/]effect[\\/]dist[\\/]FileSystem\.d\.ts$/.test(d.getSourceFile().fileName) ||
        !ts.isInterfaceDeclaration(d) || d.name.text !== "Info") return false;
    const block = d.parent;
    return ts.isModuleBlock(block) && ts.isModuleDeclaration(block.parent) && block.parent.name.text === "File";
  })) return false;
  return decls.length > 0 && decls.every((d) => HANDLE_DIST.test(d.getSourceFile().fileName)) && decls.some((d) => ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d));
}
