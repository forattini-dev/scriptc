import * as ts from "../ts7/adapter.js";
import { isNodeEsmFile, locOf, orderedImportsOf } from "../program.js";
import { BOOL, VOID, arrayOf, type IrExpr, type IrFunction, type IrStmt, type IrType, type SrcLoc } from "../../ir/ir.js";
import { type Lowerer, dynUndefinedExpr } from "./lowerer.js";
import { newFnCtx } from "./scope-env.js";
import type { FileParts } from "./lower-modules.js";
import { nativeImportTargetOf } from "./lower-native-import-types.js";

  /** Names every file's %init and registers the run-once guard globals
   * (EVERY module, the entry included: an admissible import cycle can
   * close back on the entry, whose init call must be the cache hit Node's
   * revisit is — not a recursion) BEFORE any body lowers: function bodies
   * and init bodies alike may contain require statements that lower to
   * calls of these names. Runs in every pass so the ids are
   * deterministic. */
export function prepareModuleInits(L: Lowerer, parts: FileParts[]): void {
    parts.forEach((fp, i) => L.initNameOf.set(fp.sf, `%init.${i}`));
    for (const fp of parts) {
      const rawTag = L.fileTag.get(fp.sf) ?? "";
      const tag = rawTag === "" ? "e." : rawTag.replace(/^%/, "");
      // '%' cannot appear in a user identifier, so the id can never
      // collide with a collected module global of the same file.
      const id = `%g.${tag}%loaded`;
      L.moduleGuardOf.set(fp.sf, id);
      L.globalsList.push({ id, name: "%loaded", type: BOOL, mutable: true });
    }

    // A module is intrinsically async when an await/for-await occurs
    // outside every nested function-like boundary. Then propagate that
    // status backwards through STATIC ESM edges: Node does not start an
    // importer's body until each async dependency has completed. CJS
    // import/require edges deliberately do not propagate — Node refuses
    // require(esm) when the graph contains top-level await, and the call
    // sites below keep that as a named unsupported boundary.
    for (const fp of parts) {
      let found = false;
      ts.walkPreorder(fp.sf, (node) => {
        if (node !== fp.sf && ts.isFunctionLike(node)) return "skip";
        if (
          ts.isAwaitExpression(node) ||
          (ts.isForOfStatement(node) && node.awaitModifier !== undefined)
        ) {
          found = true;
          return "stop";
        }
        return undefined;
      });
      if (found) L.asyncInitFiles.add(fp.sf);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const fp of parts) {
        if (L.asyncInitFiles.has(fp.sf) || !isNodeEsmFile(fp.sf)) continue;
        if (orderedImportsOf(L.program, fp.sf).some(({ dep }) => dep !== null && L.asyncInitFiles.has(dep))) {
          L.asyncInitFiles.add(fp.sf);
          changed = true;
        }
      }
    }
    for (const fp of parts) {
      if (!L.asyncInitFiles.has(fp.sf)) continue;
      const rawTag = L.fileTag.get(fp.sf) ?? "";
      const tag = rawTag === "" ? "e." : rawTag.replace(/^%/, "");
      const id = `%g.${tag}%initPromise`;
      L.modulePromiseOf.set(fp.sf, id);
      L.globalsList.push({
        id,
        name: "%initPromise",
        type: { kind: "promise", inner: VOID },
        mutable: true,
      });
    }

    // Synchronous ESM failures belong to the module record too. Keep the
    // cache for every static dependency when a native import exists, so
    // sibling importers rethrow the original failure without reevaluation.
    if (!L.dynamic) for (const { sf } of parts) {
      ts.walkPreorder(sf, node => {
        if (ts.isCallExpression(node)) {
          const target = nativeImportTargetOf(L, node);
          if (target) L.nativeImportTargets.add(target);
        }
        return undefined;
      });
    }
    if (L.nativeImportTargets.size > 0) for (const { sf } of parts) {
      if (L.asyncInitFiles.has(sf) || !isNodeEsmFile(sf)) continue;
      const id = `${L.moduleGuardOf.get(sf)!}.completion`;
      L.syncModulePromiseOf.set(sf, id);
      L.globalsList.push({ id, name: "%syncInitPromise", type: { kind: "promise", inner: VOID }, mutable: true });
    }

    const orderIndex = new Map(parts.map((fp, i) => [fp.sf, i] as const));
    const partSet = new Set(parts.map((fp) => fp.sf));
    const staticDeps = (sf: ts.SourceFile): ts.SourceFile[] =>
      orderedImportsOf(L.program, sf)
        .map(({ dep }) => dep)
        .filter((dep): dep is ts.SourceFile => dep !== null && dep !== sf && partSet.has(dep));

    // Tarjan SCCs over the same static graph. The last postorder member is
    // a deterministic COMPONENT representative for internal-edge tests
    // and global naming. The runtime evaluation root can differ: a cycle
    // reached only through import() starts at whichever member is actually
    // requested first, not whichever import() site preflight discovered
    // first. The shared cycle-promise slot below is filled by the emitted
    // spawn wrappers so it records that runtime choice.
    let nextIndex = 0;
    const indexOf = new Map<ts.SourceFile, number>();
    const lowOf = new Map<ts.SourceFile, number>();
    const stack: ts.SourceFile[] = [];
    const onStack = new Set<ts.SourceFile>();
    const visit = (sf: ts.SourceFile): void => {
      const at = nextIndex++;
      indexOf.set(sf, at);
      lowOf.set(sf, at);
      stack.push(sf);
      onStack.add(sf);
      for (const dep of staticDeps(sf)) {
        if (!indexOf.has(dep)) {
          visit(dep);
          lowOf.set(sf, Math.min(lowOf.get(sf)!, lowOf.get(dep)!));
        } else if (onStack.has(dep)) {
          lowOf.set(sf, Math.min(lowOf.get(sf)!, indexOf.get(dep)!));
        }
      }
      if (lowOf.get(sf) !== indexOf.get(sf)) return;
      const component: ts.SourceFile[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === sf) break;
      }
      if (component.length < 2 || !component.some((member) => L.asyncInitFiles.has(member))) return;
      const root = component.reduce((a, b) => orderIndex.get(a)! > orderIndex.get(b)! ? a : b);
      const rawTag = L.fileTag.get(root) ?? "";
      const tag = rawTag === "" ? "e." : rawTag.replace(/^%/, "");
      const cyclePromiseId = `%g.${tag}%cyclePromise`;
      L.globalsList.push({
        id: cyclePromiseId,
        name: "%cyclePromise",
        type: { kind: "promise", inner: VOID },
        mutable: true,
      });
      for (const member of component) {
        if (L.asyncInitFiles.has(member)) {
          L.asyncCycleRepresentativeOf.set(member, root);
          L.asyncCyclePromiseOf.set(member, cyclePromiseId);
        }
      }
    };
    for (const fp of parts) if (!indexOf.has(fp.sf)) visit(fp.sf);
  }

/** One file's top-level statements as its init function — RUN-ONCE like a
   * Node module body: non-entry inits open with a guard flag test (already
   * ran → return) and set the flag before anything else, so every caller —
   * hoisted import headers, inline require statements, diamonds, cache-hit
   * re-requires — gets Node's module-cache semantics from the same call.
   * After the guard comes the file's HOISTED module-edge header: one
   * guarded %init call per imported user module and the island loads for
   * npm imports, in import order (Node evaluates every imported module
   * before the importer's body — depth-first postorder falls out of the
   * nesting). CommonJS requires are NOT in the header: Node runs them at
   * their statements, so the statement lowering emits their %init calls
   * inline in the body. JSON-import bindings (pure data) load next; then
   * the body. Top-level var statements assign the pre-registered globals
   * instead of declaring locals. */
  export function lowerFileInit(L: Lowerer, sf: ts.SourceFile, stmts: ts.Statement[], name: string): IrFunction {
    const isAsync = L.asyncInitFiles.has(sf);
    const ctx = newFnCtx(false, null, null, VOID);
    ctx.isAsync = isAsync;
    return L.env.inFunction(ctx, () => {
      const loc0: SrcLoc = { file: sf.fileName, start: 0, end: 0 };
      const header: IrStmt[] = [];
      const asyncDeps: { completionId: string; loc: SrcLoc; cycleInternal: boolean }[] = [];
      const guardId = L.moduleGuardOf.get(sf);
      if (guardId !== undefined) {
        header.push({
          kind: "if",
          cond: { kind: "varRef", localId: guardId, type: BOOL, loc: loc0 },
          then: [{ kind: "return", value: null, loc: loc0 }],
          else_: null,
          loc: loc0,
        });
        // The flag sets BEFORE the body runs — Node marks the cache entry
        // before evaluating too (moot while cycles are fenced, but the
        // honest order costs nothing).
        header.push({
          kind: "assign",
          localId: guardId,
          value: { kind: "boolLit", value: true, type: BOOL, loc: loc0 },
          loc: loc0,
        });
      }
      for (const { stmt, dep } of orderedImportsOf(L.program, sf)) {
        const npm = L.npmInitActions.get(sf)?.get(stmt);
        if (npm !== undefined && npm.length > 0) {
          header.push(...npm);
        } else if (dep !== null && dep !== sf) {
          // dep === sf is the self-import (the package self-name resolving
          // to the importing module): Node answers it from the module
          // cache mid-evaluation — no re-evaluation, nothing to call (and
          // the ENTRY has no run-once guard, so a self-call would recurse).
          const depInit = L.initNameOf.get(dep);
          if (depInit !== undefined) {
            const loc = locOf(stmt);
            const depAsync = L.asyncInitFiles.has(dep);
            if (depAsync && !isAsync) {
              L.unsupported(
                "SC1090",
                stmt,
                `loading '${dep.fileName}' from a CommonJS module ` +
                  "(the required ES-module graph uses top-level await; use import() instead)",
              );
            }
            const call: IrExpr = {
              kind: "call",
              callee: depInit,
              args: [],
              type: depAsync ? { kind: "promise", inner: VOID } : VOID,
              loc,
            };
            if (depAsync) {
              // Start every dependency in source order before waiting for
              // any of them. ECMAScript's module evaluator continues into
              // later sibling dependencies while an earlier one is
              // suspended; the importer body waits for all of them.
              const p = L.declareHiddenLocal("%depInit", { kind: "promise", inner: VOID });
              header.push({ kind: "varDecl", localId: p.id, init: call, loc });
              const sfCycle = L.asyncCycleRepresentativeOf.get(sf);
              const depCycle = L.asyncCycleRepresentativeOf.get(dep);
              const cycleInternal = sfCycle !== undefined && sfCycle === depCycle;
              // An importer outside the requested member's SCC waits for
              // the SCC's RUNTIME root, not merely that member's promise.
              // Another earlier sibling can already have entered the cycle
              // through a different member; a non-root member may complete
              // while the root remains suspended. The eager spawn above has
              // published the root by the time it returns. Internal edges
              // keep the member promise: their guard-hit completion is what
              // breaks recursive evaluation without an await hop.
              const completionId =
                !cycleInternal && depCycle !== undefined
                  ? L.asyncCyclePromiseOf.get(dep)!
                  : p.id;
              asyncDeps.push({
                completionId,
                loc,
                cycleInternal,
              });
            } else {
              header.push({ kind: "exprStmt", expr: call, loc });
            }
          }
        }
      }
      if (asyncDeps.length === 1) {
        const dep = asyncDeps[0]!;
        const promiseT: IrType = { kind: "promise", inner: VOID };
        const value: IrExpr = {
          kind: "varRef",
          localId: dep.completionId,
          type: promiseT,
          loc: dep.loc,
        };
        header.push({
          kind: "exprStmt",
          expr: dep.cycleInternal
            ? { kind: "intrinsic", name: "module.await", args: [value], type: VOID, loc: dep.loc }
            : { kind: "awaitExpr", value, type: VOID, loc: dep.loc },
          loc: dep.loc,
        });
      } else if (asyncDeps.length > 1) {
        const promiseT: IrType = { kind: "promise", inner: VOID };
        const loc = asyncDeps[0]!.loc;
        const entries: IrExpr = {
          kind: "arrayLit",
          elems: asyncDeps.map((dep) => ({
            kind: "varRef",
            localId: dep.completionId,
            type: promiseT,
            loc: dep.loc,
          })),
          type: arrayOf(promiseT),
          loc,
        };
        const all: IrExpr = {
          kind: "intrinsic",
          name: "promise.all",
          args: [entries],
          type: promiseT,
          loc,
        };
        header.push({
          kind: "exprStmt",
          expr: asyncDeps.every((dep) => dep.cycleInternal)
            ? { kind: "intrinsic", name: "module.await", args: [all], type: VOID, loc }
            : { kind: "awaitExpr", value: all, type: VOID, loc },
          loc,
        });
      }
      // Module-scope `var` hoisting: undefined-armed var globals hold the
      // interned undefined from module entry (before any body statement —
      // a function called above the declaration reads `undefined`, exactly
      // Node); checked-dynamic var globals hold the dyn undefined the same
      // way. After the guard: a cache-hit revisit must not reset them.
      for (const g of L.varGlobalEntryInits.get(sf) ?? []) {
        const wrapped = g.type.kind === "dyn" ? dynUndefinedExpr(loc0) : L.unassignedSlotInit(g.type, loc0);
        if (wrapped) {
          header.push({ kind: "assign", localId: g.id, value: wrapped, loc: loc0 });
        }
      }
      const prelude = L.jsonInitActions.get(sf) ?? [];
      // Class STATIC readonly fields, static BLOCKS, and class DECORATORS
      // run at their class statement's source position (splitFiles hoisted
      // the declarations out of `stmts`, so the statements merge back in
      // by position) — exactly when JS evaluates decorators, static
      // initializers, and blocks, so code reading an earlier module
      // binding sees its assigned value.
      const statics = [...L.classes.values()]
        .filter((c) =>
          // Class DECLARATIONS only: expression classes run their static
          // inits through pendingClassExprInits (below) at the statement
          // that evaluates them. MIXIN instantiations join by their CALL
          // SITE's position instead (below) — their inner class node may
          // even live in another file.
          c.decl && ts.isClassDeclaration(c.decl) && !c.mixinInstance && c.decl.getSourceFile() === sf &&
          (c.staticFields.length > 0 || (c.staticBlocks?.length ?? 0) > 0 || c.classDecorators !== undefined))
        .map((c) => ({ pos: c.decl!.getStart(), info: c }));
      // Statics-bearing MIXIN instantiations whose call evaluates in THIS
      // file: their declaration-time code runs when the call does — the
      // top-level statement lower-mixins recorded. Insertion order is
      // demand order (a nested mixin's base instantiates first, a
      // heritage base before its derived class), so the stable sort keeps
      // JS's evaluation order at equal positions.
      for (const c of L.classes.values()) {
        const ms = c.mixinInstance?.statics;
        if (ms && ms.sf === sf) statics.push({ pos: ms.pos, info: c });
      }
      statics.sort((a, b) => a.pos - b.pos);
      const body = [...header, ...prelude];
      let at = 0;
      for (const stmt of stmts) {
        // `<=`: a mixin instantiation's position IS its statement's start
        // — its statics run mid-statement in JS (the call), before
        // anything the statement's lowering emits. Hoisted class
        // declarations never share a kept statement's start, so `<=`
        // changes nothing for them.
        while (at < statics.length && statics[at]!.pos <= stmt.getStart()) {
          body.push(...L.lowerStaticFieldInits(statics[at]!.info));
          at++;
        }
        const stmtIr = L.lowerStmts([stmt]);
        // Class EXPRESSIONS inside this statement queued their static
        // inits while it lowered: they land immediately before it — JS's
        // order for the supported whole-initializer positions.
        body.push(...L.pendingClassExprInits.splice(0), ...stmtIr);
      }
      while (at < statics.length) {
        body.push(...L.lowerStaticFieldInits(statics[at]!.info));
        at++;
      }
      const loc: SrcLoc = { file: sf.fileName, start: 0, end: 0 };
      return {
        name,
        params: [],
        returnType: VOID,
        locals: L.ctx.locals,
        body,
        ...(isAsync ? { async: true as const } : {}),
        ...(L.syncModulePromiseOf.has(sf) ? { syncModuleCacheGlobal: L.syncModulePromiseOf.get(sf)! } : {}),
        ...(isAsync ? { asyncCacheGlobal: L.modulePromiseOf.get(sf)! } : {}),
        ...(L.asyncCyclePromiseOf.has(sf)
          ? { asyncCycleCacheGlobal: L.asyncCyclePromiseOf.get(sf)! }
          : {}),
        loc,
      };
    });
  }


/** Unreached import sites must not make an otherwise static executable
 * require the native loader or allocate internal evaluation promises. */
export function pruneUnusedNativeModuleCaches(L: Lowerer, functions: IrFunction[]): void {
  if (L.dynamic || L.dynNsBuilders.size !== 0 || L.syncModulePromiseOf.size === 0) return;
  const ids = new Set(L.syncModulePromiseOf.values());
  for (const fn of functions) delete fn.syncModuleCacheGlobal;
  for (let index = L.globalsList.length - 1; index >= 0; index--) {
    const global = L.globalsList[index];
    if (global && ids.has(global.id)) L.globalsList.splice(index, 1);
  }
}
