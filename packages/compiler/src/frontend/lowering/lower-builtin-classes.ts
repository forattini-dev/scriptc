/* The RUNTIME-PROVIDED builtin classes as ClassInfos: the Error hierarchy, node:events EventEmitter and the node:stream
 * classes (registered eagerly — mapType names them the moment a lib type appears), plus the symbol → info lookups the
 * class collection and the receivers use. Split from lower-classes.ts (which owns program classes). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { BOOL, DYN, IrType, RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES, STRING, UNDEFINED_T } from "../../ir/ir.js";
import { isNodeTypesPath } from "../program.js";
import { typeKey } from "../type-mapper.js";

/** The builtin Error hierarchy (Error + TypeError/RangeError/SyntaxError)
 * as eagerly-registered ClassInfos: mapType names them the moment a lib
 * Error type appears, so the infos must exist before any lowering. They
 * are runtime-provided — no decl, no lowerable bodies; `new`/super()/
 * toString reach them through dedicated error.* libCall lowerings, and
 * user classes extend them like any base (the emitted subclass struct
 * embeds ScrError's prefix). */
export function registerBuiltinErrorClasses(L: Lowerer): void {
  const loc = { file: "<builtin>", start: 0, end: 0 };
  for (const [irName, rec] of RUNTIME_ERROR_CLASSES) {
    const base = rec.base ? (L.classes.get(rec.base) ?? null) : null;
    const info: ClassInfo = {
      def: {
        name: irName,
        runtime: true,
        ...(rec.base ? { base: rec.base } : {}),
        // Layout only — `%code` is ScrError's third slot (NULL = absent;
        // fs/exec throw sites stamp it): subclass structs embed it in
        // their prefix, and teardown releases it NULL-guarded like any
        // string field. The '%' name keeps it out of user reach (a
        // subclass declaring its own `code` field lays out AFTER it,
        // never colliding), and it is NOT in the fields map below: the
        // READ has its own `string | undefined` lowering (error.code),
        // never a plain-string field access.
        fields: [
          { name: "name", type: STRING },
          { name: "message", type: STRING },
          { name: "%code", type: STRING },
          { name: "%hasCause", type: BOOL },
          { name: "%cause", type: DYN },
        ],
        loc,
      },
      fields: new Map([
        ["name", STRING],
        ["message", STRING],
      ]),
      fieldOrder: [],
      // Only the root declares toString — subclasses (builtin and user)
      // reach it through the base-chain walk, so its declarer is always
      // %Error and calls lower to the one runtime implementation.
      methods: rec.base === null
        ? new Map([["toString", { params: [], ret: STRING }]])
        : new Map(),
      decl: null,
      builtinError: true,
      ctor: null,
      // Display shape of `new Error(message?)`. Construction and super()
      // never complete against this — errorMessageArg owns those (the
      // runtime ABI is one plain string; "" when omitted, like Node).
      ctorParams: [{ type: STRING, mode: "omittable" }],
      base,
      subclasses: [],
      throwingSetters: [],
      staticFields: [],
    };
    if (base) base.subclasses.push(info);
    L.classes.set(irName, info);
  }
}

/** The runtime-provided node:events EventEmitter as an eagerly-registered
 * ClassInfo (the error-hierarchy story): mapType names `%EventEmitter`
 * the moment an emitter type appears, so the info must exist before any
 * lowering. No decl, no lowerable bodies — `new`/super() reach it
 * through emitter.* libCalls, the method surface lowers through
 * lower-emitter.ts, and user classes extend it like any base (the
 * emitted subclass struct embeds ScrEmitter's registry/name prefix —
 * carried by the BACKEND, not by IR fields, so the fields list stays
 * empty and subclass field layout starts right after the prefix). */
export function registerBuiltinEmitterClass(L: Lowerer): void {
  const loc = { file: "<builtin>", start: 0, end: 0 };
  const info: ClassInfo = {
    def: { name: RUNTIME_EMITTER_CLASS, runtime: true, fields: [], loc },
    fields: new Map(),
    fieldOrder: [],
    methods: new Map(),
    decl: null,
    builtinEmitter: true,
    ctor: null,
    // `new EventEmitter()` — zero-argument (the options bag fences at
    // construction sites; the checker may admit it via @types/node).
    ctorParams: [],
    base: null,
    subclasses: [],
    throwingSetters: [],
    staticFields: [],
  };
  L.classes.set(RUNTIME_EMITTER_CLASS, info);
}

/** The runtime-provided node:stream classes as eagerly-registered
 * ClassInfos (the emitter story): mapType names `%Readable` et al the
 * moment a stream type appears, so the infos must exist before any
 * lowering. Each roots at the emitter through its base chain, so the
 * EventEmitter method surface, upcasts, and instanceof intervals apply
 * unchanged; the stream method/property surface lowers through
 * lower-stream.ts. No decl, no lowerable bodies, empty field lists —
 * every instance is runtime-allocated (user `extends` is fenced). */
export function registerBuiltinStreamClasses(L: Lowerer): void {
  const loc = { file: "<builtin>", start: 0, end: 0 };
  for (const [irName, rec] of RUNTIME_STREAM_CLASSES) {
    const base = L.classes.get(rec.base) ?? null;
    const info: ClassInfo = {
      def: { name: irName, runtime: true, base: rec.base, fields: [], loc },
      fields: new Map(),
      fieldOrder: [],
      methods: new Map(),
      decl: null,
      builtinStream: rec.sides,
      ctor: null,
      // `new Readable(opts?)` — the options bag is parsed structurally
      // by the stream spoke (lowerNew never completes against this).
      ctorParams: [],
      base,
      subclasses: [],
      throwingSetters: [],
      staticFields: [],
    };
    if (base) base.subclasses.push(info);
    L.classes.set(irName, info);
  }
}

/** The stream ClassInfo a VALUE symbol refers to (`new Readable(...)`,
 * `x instanceof Writable`) — any import spelling resolves to the
 * ambient class. Provenance: a stdlib-file CLASS declaration inside the
 * "stream" ambient module, EXCLUDING @types/node's (whose stream.Readable
 * also types child stdio — under @types/node the childStream mapping
 * keeps priority and the static stream classes stand down; the shipped
 * fallback declarations are the supported surface). */
export function builtinStreamInfoOf(L: Lowerer, symbol: ts.Symbol | null | undefined): ClassInfo | null {
  if (!symbol) return null;
  if (!L.isStdlibSymbol(symbol)) {
    // A const ALIAS of a namespace member (`const Writable =
    // stream.Writable` — the two-step spelling; the one-step
    // require('stream').Writable rides the same walk): follow the
    // member to the stdlib class symbol. The declaration itself is
    // alias plumbing (streamClassAliasDecl — both declaration walks
    // skip it).
    const decl = L.checker.valueDeclarationOf(symbol);
    if (
      decl && ts.isVariableDeclaration(decl) &&
      (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0 &&
      decl.initializer !== undefined &&
      ts.isPropertyAccessExpression(decl.initializer) &&
      !decl.initializer.questionDotToken &&
      L.builtinNamespaceModuleOf(decl.initializer.expression) === "stream"
    ) {
      const mSym = L.checker.getSymbolAtLocation(decl.initializer.name);
      const target = mSym && mSym.flags & ts.SymbolFlags.Alias ? L.checker.getAliasedSymbol(mSym) : mSym;
      if (target && target !== symbol) return builtinStreamInfoOf(L, target);
    }
    return null;
  }
  let irName: string | null = null;
  for (const [name, rec] of RUNTIME_STREAM_CLASSES) {
    if (rec.lib === symbol.name) irName = name;
  }
  if (!irName) return null;
  const declared = L.checker.declarationsOf(symbol).some((d) => {
    if (!ts.isClassDeclaration(d)) return false;
    if (isNodeTypesPath(d.getSourceFile().fileName)) return false;
    let node: ts.Node | undefined = d.parent;
    while (node) {
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
        return node.name.text === "stream" || node.name.text === "node:stream";
      }
      node = node.parent;
    }
    return false;
  });
  return declared ? (L.classes.get(irName) ?? null) : null;
}

/** The undefined-armed union of a JS class property's inferred type — the
 * honest slot for a field first assigned outside the constructor's top
 * level (undefined until the write runs, Node-exact). Null when the
 * inference is unmappable, checked-dynamic (dyn stays out of class
 * fields — KEEP NARROW), or an arm-less kind that cannot join a union
 * (genResultRecord's list, including scalar-backed Date values). */
export function undefArmedFieldType(L: Lowerer, p: ts.Symbol): IrType | null {
  const t = L.checker.getTypeOfSymbol(p);
  const mapped = L.mapTypeOf(t);
  if (!mapped || mapped.kind === "void" || mapped.kind === "dyn") return null;
  const byKey = new Map<string, IrType>();
  const arms = mapped.kind === "union" ? (L.unions.get(mapped.unionId)?.arms ?? []) : [mapped];
  for (const a of arms) {
    if (
      a.kind === "map" || a.kind === "regex" || a.kind === "date" ||
      a.kind === "jsval" || a.kind === "generator"
    ) {
      return null;
    }
    byKey.set(typeKey(a), a);
  }
  byKey.set(typeKey(UNDEFINED_T), UNDEFINED_T);
  const sorted = [...byKey.values()].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: L.unions.intern(sorted) };
}

/** The emitter ClassInfo a VALUE symbol refers to (`new EventEmitter`,
 * `extends EventEmitter`, `x instanceof EventEmitter`) — any import
 * spelling (named/default/namespace member, CJS require) resolves to
 * the ambient class. Provenance-checked like the error classes: only a
 * stdlib-file declaration inside the "events" ambient module counts. */
export function builtinEmitterInfoOf(L: Lowerer, symbol: ts.Symbol | null | undefined): ClassInfo | null {
  if (!symbol) return null;
  if (!L.isStdlibSymbol(symbol)) {
    // A const ALIAS of the emitter class member (`const EventEmitter =
    // require('node:events').EventEmitter` — commander's spelling; the
    // two-step `const EE = events.EventEmitter` rides the same walk):
    // follow the member off the module namespace. The declaration
    // itself is alias plumbing (builtinMemberRequireDecl — both
    // declaration walks skip it).
    const decl = L.checker.valueDeclarationOf(symbol);
    if (
      decl !== undefined && ts.isVariableDeclaration(decl) &&
      (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0 &&
      decl.initializer !== undefined &&
      ts.isPropertyAccessExpression(decl.initializer) &&
      !decl.initializer.questionDotToken &&
      decl.initializer.name.text === "EventEmitter" &&
      L.builtinNamespaceModuleOf(decl.initializer.expression) === "events"
    ) {
      return L.classes.get(RUNTIME_EMITTER_CLASS) ?? null;
    }
    return null;
  }
  if (symbol.name !== "EventEmitter") return null;
  const declared = L.checker.declarationsOf(symbol).some((d) => {
    if (!ts.isClassDeclaration(d) && !ts.isInterfaceDeclaration(d)) return false;
    let node: ts.Node | undefined = d.parent;
    while (node) {
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
        return node.name.text === "events" || node.name.text === "node:events";
      }
      node = node.parent;
    }
    return false;
  });
  return declared ? (L.classes.get(RUNTIME_EMITTER_CLASS) ?? null) : null;
}

/** The builtin error ClassInfo a VALUE symbol refers to (`new Error`,
 * `extends TypeError`, `x instanceof RangeError`), or null. Provenance-
 * checked: only the standard library's declarations count — a user's own
 * `class Error` resolves through classBySymbol instead. */
export function builtinErrorInfoOf(L: Lowerer, symbol: ts.Symbol | null | undefined): ClassInfo | null {
  if (!symbol || !L.isStdlibSymbol(symbol)) return null;
  for (const [irName, rec] of RUNTIME_ERROR_CLASSES) {
    if (rec.lib === symbol.name) return L.classes.get(irName) ?? null;
  }
  return null;
}

/** The instance-method surface the runtime EventEmitter owns — subclass
 * members with these names are fenced (collectClassShapeInner) and calls
 * to them on emitter-rooted receivers lower through lower-emitter.ts. */
export const EMITTER_API_MEMBERS: ReadonlySet<string> = new Set([
"on", "addListener", "once", "prependListener", "prependOnceListener",
"off", "removeListener", "removeAllListeners", "emit", "listenerCount",
"listeners", "rawListeners", "eventNames", "setMaxListeners", "getMaxListeners",
]);

