/* Refinements of the benign-cycle admission's INERT top level (program.ts, nonInertTopLevel7): forms that cannot
 * run user code during a cycle's init window even though they are not literal declarations — member calls on
 * declaration-owned values, kernel construction that only STORES callbacks, module-namespace reads, and calls into
 * program functions whose module cannot reach the cycle's cluster. */
import * as ts from "./ts7/adapter.js";
import type { CycleEdge } from "./program.js";

const KERNEL_DIST = /[\\/]node_modules[\\/]effect[\\/]dist[\\/]/;

function aliased(checker: ts.TypeChecker, sym: ts.Symbol | undefined): ts.Symbol | undefined {
  return sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(sym) : sym;
}

function allDeclarations(checker: ts.TypeChecker, sym: ts.Symbol | undefined, test: (sf: ts.SourceFile) => boolean): boolean {
  const decls = sym === undefined ? [] : checker.declarationsOf(aliased(checker, sym)!);
  return decls.length > 0 && decls.every((d) => test(d.getSourceFile()));
}

/** The identifier a callee/property chain roots at (through calls and members), or null. */
export function chainRootIdent(e: ts.Expression): ts.Identifier | null {
  let root: ts.Expression = e;
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root) || ts.isCallExpression(root) || ts.isNonNullExpression(root) || ts.isParenthesizedExpression(root)) root = root.expression;
  return ts.isIdentifier(root) ? root : null;
}

/** Every CALL along a callee chain (`Schema.Struct({…}).annotate(…)`) is itself inert; the chain roots at an identifier. */
export function calleeChainInert(callee: ts.Expression, inert: (e: ts.Expression) => boolean): boolean {
  for (let c: ts.Expression = callee; !ts.isIdentifier(c); ) {
    if (ts.isCallExpression(c)) { if (!inert(c)) return false; c = c.expression; }
    else if (ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c) || ts.isNonNullExpression(c) || ts.isParenthesizedExpression(c)) c = c.expression;
    else return false;
  }
  return true;
}

/** A method call on a DECLARATION-OWNED value: the member and the receiver's type both live in declaration files
 * (`RelativePath.pipe(Schema.optional)` — a program binding holding an effect Schema; no program class can override
 * anything here), and the receiver itself is inert. Runtime-implemented, like a dts-rooted call. */
export function isDtsMemberCall(checker: ts.TypeChecker, callee: ts.Expression, inert: (e: ts.Expression) => boolean): boolean {
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const dts = (sf: ts.SourceFile): boolean => sf.isDeclarationFile;
  if (!allDeclarations(checker, checker.getSymbolAtLocation(callee.name), dts)) return false;
  // The receiver's constituents that DECLARE the member (a branded Schema is `brand<…> & { create }`: `.make` is the
  // Schema part's) must all be declaration-owned — a program object literal typed by a dts interface is user code.
  const receiver = checker.getTypeAtLocation(callee.expression);
  const constituents = ts.constituentTypes(receiver);
  const declaring = (constituents.length > 0 ? constituents : [receiver]).filter((part) => checker.getPropertyOfType(part, callee.name.text) !== undefined);
  return declaring.length > 0 && declaring.every((part) => allDeclarations(checker, part.getAliasSymbol() ?? part.getSymbol(), dts)) && inert(callee.expression);
}

/** A call rooted at a KERNEL package namespace (effect) whose member is not a runner: the kernel builds a description
 * and stores the callbacks (`Effect.gen(function* () {…})`, `Layer.effect(S, …)`, `Effect.fn("n")(function* …)`);
 * nothing runs until a fiber does — so function-literal arguments are admissible. `run*`/`unsafe*` members run. */
export function kernelCallHoldsCallbacks(checker: ts.TypeChecker, callee: ts.Expression): boolean {
  const root = chainRootIdent(callee);
  if (root === null || !allDeclarations(checker, checker.getSymbolAtLocation(root), (sf) => KERNEL_DIST.test(sf.fileName))) return false;
  for (let c: ts.Expression = callee; !ts.isIdentifier(c); ) {
    if (ts.isPropertyAccessExpression(c)) { if (/^(run|unsafe)/.test(c.name.text)) return false; c = c.expression; }
    else if (ts.isCallExpression(c) || ts.isNonNullExpression(c) || ts.isParenthesizedExpression(c)) c = c.expression;
    else return false;
  }
  return true;
}

/** `Ns.member` where `Ns` is a MODULE NAMESPACE binding (`import * as Ns` / `export * as Ns`, a TS namespace): a data
 * read that runs no user code (namespace objects have no user getters). Whether the module finished initializing is
 * the ORDER question — the compiled program reproduces the walk's order, and a read across the cycle-closing edge is
 * the back-edge use check's (backEdgeUseOffence7). */
export function isNamespaceMemberRead(checker: ts.TypeChecker, e: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(e)) return false;
  let root: ts.Expression = e;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  if (!ts.isIdentifier(root)) return false;
  const sym = aliased(checker, checker.getSymbolAtLocation(root));
  return sym !== undefined && (sym.flags & ts.SymbolFlags.ValueModule) !== 0;
}

/** Import-graph reachability into the cluster (memoized per module): a module that reaches no cluster member cannot
 * name a cluster binding, so a function of its running during the window observes nothing partial. */
export function makeReachesCluster(edgesOf: (sf: ts.SourceFile) => readonly CycleEdge[], cycleMembers: ReadonlySet<ts.SourceFile>): (sf: ts.SourceFile) => boolean {
  const memo = new Map<ts.SourceFile, boolean>();
  const walk = (sf: ts.SourceFile, stack: Set<ts.SourceFile>): boolean => {
    if (cycleMembers.has(sf)) return true;
    const known = memo.get(sf);
    if (known !== undefined) return known;
    if (stack.has(sf)) return false;
    stack.add(sf);
    const reaches = edgesOf(sf).some((edge) => walk(edge.dep, stack));
    stack.delete(sf);
    memo.set(sf, reaches);
    return reaches;
  };
  return (sf) => walk(sf, new Set());
}

/** A call to a PROGRAM function (`makeLocationNode({…})` — a declaration, or a `const` holding a function value such as
 * `tags.make("location")`) from a module outside the cluster that cannot reach it: whatever runs can only touch that
 * module's environment and its imports (transitively) — none of the cluster's bindings. Arguments are checked by the
 * caller (identifiers hand over evaluated values; function literals stay refused: the callee could run them). */
export function isOutsideClusterProgramCallee(checker: ts.TypeChecker, callee: ts.Expression, cycleMembers: ReadonlySet<ts.SourceFile>, reachesCluster: (sf: ts.SourceFile) => boolean): boolean {
  const root = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression : null;
  if (root === null) return false;
  const sym = aliased(checker, checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : root));
  if (sym === undefined) return false;
  const decls = checker.declarationsOf(sym);
  const isFn = (d: ts.Node): boolean => ts.isFunctionDeclaration(d) || (ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0);
  return decls.length > 0 && decls.every((d) => isFn(d) && !d.getSourceFile().isDeclarationFile && !cycleMembers.has(d.getSourceFile()) && !reachesCluster(d.getSourceFile()));
}

/** A call to a HOISTED function declaration (any module — function declarations are callable mid-initialization)
 * whose body is inert: every value read is a parameter, a local, a declaration-file symbol, an import from a module
 * outside the cluster (finished, and unable to reach the cluster — else it would be a member), or another such
 * function; calls inside are to those alone with no function-literal arguments; no `this`/`await`/`yield`/`new` of
 * program classes. `define(plugin) { return plugin }` is the shape. The caller checks the call's own arguments. */
export function isInertHoistedFunctionCallee(checker: ts.TypeChecker, callee: ts.Expression, cycleMembers: ReadonlySet<ts.SourceFile>, memo: Map<ts.Node, boolean>): boolean {
  const target = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : null;
  if (target === null) return false;
  const sym = aliased(checker, checker.getSymbolAtLocation(target));
  const decls = sym === undefined ? [] : checker.declarationsOf(sym);
  if (decls.length !== 1 || !ts.isFunctionDeclaration(decls[0]!) || decls[0]!.body === undefined) return false;
  const fn = decls[0] as ts.FunctionDeclaration;
  if (fn.asteriskToken !== undefined || (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async) !== 0) return false;
  const known = memo.get(fn);
  if (known !== undefined) return known;
  memo.set(fn, true); // in progress: recursion is fine
  const inside = (d: ts.Node): boolean => d.getSourceFile() === fn.getSourceFile() && d.pos >= fn.pos && d.end <= fn.end;
  const outsideCluster = (d: ts.Node): boolean => !d.getSourceFile().isDeclarationFile && !cycleMembers.has(d.getSourceFile());
  let ok = true;
  ts.walkPreorder(fn.body!, (n) => {
    if (!ok) return "stop";
    if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword || ts.isAwaitExpression(n) || ts.isYieldExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n)) { ok = false; return "stop"; }
    if (ts.isCallExpression(n)) {
      const root = chainRootIdent(n.expression);
      const rootSym = root === null ? undefined : checker.getSymbolAtLocation(root);
      const fnCallee = isInertHoistedFunctionCallee(checker, n.expression, cycleMembers, memo);
      const finishedOrDts = root !== null && !inside(root) && allDeclarations(checker, rootSym, (sf) => sf.isDeclarationFile || !cycleMembers.has(sf));
      const noCallbacks = n.arguments.every((a) => !ts.isFunctionLike(a) && !ts.isObjectLiteralExpression(a) && !ts.isArrayLiteralExpression(a));
      if (!fnCallee && !(finishedOrDts && noCallbacks)) { ok = false; return "stop"; }
    }
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      if ((ts.isPropertyAccessExpression(parent) && parent.name === n) || (ts.isPropertyAssignment(parent) && parent.name === n) || ts.isTypeNode(parent) || ts.isTypeReferenceNode(parent)) return undefined;
      if ((ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === n) return undefined;
      const s = checker.getSymbolAtLocation(n);
      if (s === undefined) { ok = false; return "stop"; }
      const ds = checker.declarationsOf(aliased(checker, s)!);
      const fine = ds.length > 0 && ds.every((d) => inside(d) || d.getSourceFile().isDeclarationFile || (ts.isFunctionDeclaration(d) && isInertHoistedFunctionCallee(checker, n, cycleMembers, memo)) || ((s.flags & ts.SymbolFlags.Alias) !== 0 && outsideCluster(d)));
      if (!fine) { ok = false; return "stop"; }
    }
    return undefined;
  });
  memo.set(fn, ok);
  return ok;
}

/** An import binding of a FUNCTION DECLARATION: hoisted at instantiation across the whole cycle, so a read during
 * the init window never meets a TDZ (calling it at a top level is the inert-hoisted-function rule's question). */
export function isHoistedFunctionBinding(checker: ts.TypeChecker, sym: ts.Symbol): boolean {
  const decls = checker.declarationsOf(aliased(checker, sym)!);
  return decls.length > 0 && decls.every((d) => ts.isFunctionDeclaration(d));
}
