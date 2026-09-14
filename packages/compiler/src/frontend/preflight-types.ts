import { dirname } from "node:path";
import * as ts from "./ts7/adapter.js";
import { tscPassthroughDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { LoadResult } from "./program.js";
import { isNodeModulesPath, resolveBareAsset, resolveBareModule, resolveRelativeAsset } from "./resolve.js";
import { npmStaticPackageOfPath } from "./npm-static.js";
import { isJsSourceFileName, JS_ANY_OPERATOR_CODES, JS_RELAXED_TSC_CODES } from "./tsc-codes.js";
import { canonicalBuiltinModule, SUPPORTED_NODE_MODULES, KERNEL_MODULES } from "./builtin-modules.js";
import { isRelativeSpecifier, isWorkspacePackageName, registerWorkspacePackage, workspacePackageOfPath } from "./workspace-registry.js";

/* Finding 5: tsgo's strict CommonJS modeling fires checker codes on JS
 * shapes 5.9.3 accepted, and the real hazards those shapes carry are fenced
 * by scriptc's OWN analysis, never by these codes — so for JS FILES ONLY
 * they join the relaxation (TS sources keep the full gate; the order-parity
 * harness holds both lanes to identical verdicts, so a case where 5.9.3
 * itself raises one of these on a JS file would fail there, not slip by):
 *  - TS2309 ("export assignment with other exported elements") on the
 *    table-then-member pattern — cjsExportDiscardReason names every export
 *    Node actually discards.
 *  - TS2323 ("cannot redeclare exported variable") on symbol-keyed expando
 *    assignments in CJS classes (`this[kSym] = v` under `module.exports =
 *    Class`) — 5.9.3 synthesized expando symbols, tsgo trips its
 *    redeclaration check instead (the corpus's countdown fixture). */
const TS7_JS_RELAXED_EXTRA: ReadonlySet<number> = new Set([2309, 2323]);

function suppressedJsStrictness7(d: ts.Diagnostic): boolean {
  const file = d.fileName;
  if (!file || !isJsSourceFileName(file)) return false;
  if (JS_RELAXED_TSC_CODES.has(d.code) || TS7_JS_RELAXED_EXTRA.has(d.code)) return true;
  // The 8xxx range is TypeScript's JSDoc-specific diagnostic family
  // (malformed tags, signature/tag mismatches): comment semantics with no
  // runtime meaning in a JS file.
  if (d.code >= 8000 && d.code <= 8999) return true;
  if (JS_ANY_OPERATOR_CODES.has(d.code)) {
    return ts.flattenDiagnosticMessageText(d, "\n").includes("'any'");
  }
  return false;
}

/** Foreign JavaScript contributes types but has a separate execution boundary. */
export function isIslandJsFile(file: string): boolean {
  return isJsSourceFileName(file) && npmStaticPackageOfPath(file) === null &&
    (isNodeModulesPath(file) || workspacePackageOfPath(file) !== null);
}

/** The configuration/type phase of preflight, including workspace provenance
 * and the project-world check without lowering overrides. Attribution probes
 * consume only these diagnostics; native admission must still run the full
 * structural preflight before lowering. No AST or checker is cached here. */
export function checkPreflightTypes(load: LoadResult): ScrDiagnostic[] {
  const { program, entry } = load;
  const diags: ScrDiagnostic[] = [...load.configDiags];

  // Workspace-linked packages register BEFORE the tsc gate. Their files
  // live at realpaths OUTSIDE node_modules (the monorepo-tool symlink
  // shape), so nothing path-shaped marks them as npm surface — yet their
  // shipped JS is the identical foreign-tsconfig story as node_modules JS
  // (the island executes it under --dynamic; the author's own build
  // checked it, the program's author cannot fix it). The lazy
  // registration inside the import-fence walk below runs AFTER errorsOf,
  // too late for the gate, so one pass over the program's import edges
  // registers them up front: every bare specifier any program file loads —
  // import/export declarations, dynamic import("literal") (tsgo chases
  // those into the program too; a CLI reaches its workspace sibling exactly
  // that way), require("literal") — resolved with the own resolver,
  // workspace answers recorded.
  {
    const supportedBuiltins = new Set<string>(SUPPORTED_NODE_MODULES);
    const probed = new Set<string>();
    const probe = (fromFile: string, spec: string): void => {
      if (
        isRelativeSpecifier(spec) ||
        spec.startsWith("#") ||
        spec.startsWith("node:") ||
        supportedBuiltins.has(spec)
      ) {
        return;
      }
      const key = `${dirname(fromFile)} ${spec}`;
      if (probed.has(key)) return;
      probed.add(key);
      const r = resolveBareModule(fromFile, spec);
      if (r !== null && r.workspaceDir !== undefined) registerWorkspacePackage(r.packageName, r.workspaceDir);
    };
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile || sf.fileName.endsWith(".json")) continue;
      ts.walkPreorder(sf, (n) => {
        if (
          (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
          n.moduleSpecifier !== undefined &&
          ts.isStringLiteral(n.moduleSpecifier)
        ) {
          probe(sf.fileName, n.moduleSpecifier.text);
          return "skip";
        }
        if (ts.isCallExpression(n)) {
          const arg = n.arguments[0];
          const isImportCall = n.expression.kind === ts.SyntaxKind.ImportKeyword;
          const isRequireCall = ts.isIdentifier(n.expression) && n.expression.text === "require";
          if ((isImportCall || isRequireCall) && arg !== undefined && ts.isStringLiteralLike(arg)) {
            probe(sf.fileName, arg.text);
          }
        }
        return undefined;
      });
    }
  }

  const toPassthrough = (d: ts.Diagnostic): ScrDiagnostic => {
    const message = ts.flattenDiagnosticMessageText(d, "\n");
    // File-less (global/options) diagnostics anchor at the entry with a
    // zero span, exactly like the 5.9.3 lane's `d.start ?? 0` fallback.
    const file = d.fileName ?? entry.fileName;
    const start = d.fileName !== undefined ? d.pos : 0;
    const end = d.fileName !== undefined ? d.end : 0;
    return tscPassthroughDiag(message, { file, start, end });
  };
  /* TS7 checker change (not finding 5, same discipline): tsgo types a
   * NAMESPACE import as the spec's non-callable module namespace object
   * even when the module is declared with the callable `export =` shape —
   * 5.9.3 bound the callable value directly, so `import * as a from
   * "node:assert"; a(x)` typechecked there and draws TS2349 here. Those
   * callable module objects are scriptc's OWN declared surface, and calls
   * through the namespace binding are fenced per site by the lowering (the
   * assert-fences fixture pins the wording), so tsgo's extra TS2349 on
   * exactly those callees — an identifier that is a namespace-import
   * binding of a supported builtin module — is suppressed to the 5.9.3
   * verdict. Nothing else rides this: any other non-callable call keeps
   * tsc's voice in both lanes. */
  const builtinNamespaceNames = new Map<string, Set<string>>();
  const namespaceCalleeSuppressed = (p: ts.Program, d: ts.Diagnostic): boolean => {
    if (d.code !== 2349 || d.fileName === undefined) return false;
    let names = builtinNamespaceNames.get(d.fileName);
    if (!names) {
      names = new Set();
      builtinNamespaceNames.set(d.fileName, names);
      const sf = p.getSourceFile(d.fileName);
      for (const stmt of sf?.statements ?? []) {
        if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        if (canonicalBuiltinModule(stmt.moduleSpecifier.text) === null) continue;
        const bindings = stmt.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
      }
    }
    if (names.size === 0) return false;
    const sf = p.getSourceFile(d.fileName);
    return sf !== undefined && names.has(sf.text.slice(d.pos, d.end));
  };
  /* --npm-static: checker errors INSIDE an opted-in package's files never
   * gate the build — the package's author checked that JS under a foreign
   * tsconfig (their own lib choices, their own strictness), the program's
   * author cannot fix it, and the JS design already names where inference
   * gaps land: the per-statement runtime fences (trust-but-verify — a
   * statement the checker could not prove compiles to its honest trap,
   * never to a silent guess). scriptc's OWN SC1xxx fences in those files
   * still count — preflight structure problems mark the package an
   * offender and it falls back to the island. */
  const npmStaticFileSuppressed = (d: ts.Diagnostic): boolean =>
    d.fileName !== undefined && npmStaticPackageOfPath(d.fileName) !== null;
  /* The same doctrine for node_modules JS the opt-in never NAMED:
   * maxNodeModuleJsDepth (set only on --npm-static loads) admits ANY
   * node_modules JavaScript the checker's resolution touches — e.g. an
   * ambient `declare module "punycode"` in @types/node now loses to an
   * INSTALLED punycode package's JS, which checkJs then checks. Those
   * files' errors are the identical foreign-tsconfig story (third-party
   * shipped JS the program's author cannot fix), they were invisible to
   * every flagless compile (depth 0 keeps node_modules JS out of the
   * program), and the packages themselves still island — so their checker
   * errors never gate a build. */
  /* WORKSPACE-LINKED shipped JS is the same story at a different path: the
   * package's files realpath OUTSIDE node_modules (so depth-0 exclusion
   * never saw them and allowJs+checkJs pulls them straight into the
   * program), but they are npm surface all the same — the island executes
   * them, the program's author cannot fix them (a workspace package shipping
   * an ncc bundle with dozens of checker errors). Registered up front (the
   * pass above), suppressed here unless --npm-static opted them into being
   * program modules. */
  const nodeModulesJsSuppressed = (d: ts.Diagnostic): boolean =>
    d.fileName !== undefined && isIslandJsFile(d.fileName);
  /* JSDoc TYPE positions in JS files are documentation Node never reads:
   * a name-resolution failure THERE (2304/2552 — the pattern's utilities.js
   * spells a mapped type over a @template name it never declared) types
   * as the error-any and the per-site fences apply, same stance as the
   * strictness families above. A 2300 duplicate-identifier PAIR formed by
   * a @typedef and a same-named class/function is the same story — the
   * typedef half sits inside the comment, and the code half is suppressed
   * exactly when its partner (same file, same name) was comment-side, so
   * a REAL duplicate declaration (both halves in code — Node's own
   * SyntaxError) keeps tsc's voice. */
  const insideBlockComment = (text: string, pos: number): boolean => {
    const open = text.lastIndexOf("/*", pos);
    if (open < 0) return false;
    const close = text.indexOf("*/", open + 2);
    return close === -1 || close >= pos;
  };
  const jsdocTypeSuppressed = (p: ts.Program, d: ts.Diagnostic, commentDup: Set<string>): boolean => {
    if (d.fileName === undefined || !isJsSourceFileName(d.fileName)) return false;
    if (d.code !== 2304 && d.code !== 2552 && d.code !== 2300 && d.code !== 1003) return false;
    if (d.pos === undefined) return false;
    const sf = p.getSourceFile(d.fileName);
    if (!sf) return false;
    if (insideBlockComment(sf.text, d.pos)) return true;
    return d.code === 2300 && commentDup.has(`${d.fileName}:${sf.text.slice(d.pos, d.end)}`);
  };
  /* A workspace member installed by COPY ships its JS inside node_modules,
   * where depth-0 exclusion keeps it out of the checker's program — an
   * UNTYPED member then types as an implicit-any module (TS7016) at every
   * import site. The symlinked install of the same tree never sees this
   * (the realpath escapes node_modules and allowJs types the member from
   * its JS), and the package is the program author's own workspace code
   * with the island as its execution home — "install @types" is not
   * actionable — so the copied shape must not gate either: a 7016 whose
   * specifier names a REGISTERED workspace package (the eager
   * registration pass above runs first) is suppressed, and the import
   * takes the same per-site island story as any untyped npm package. */
  const workspaceImplicitAnySuppressed = (p: ts.Program, d: ts.Diagnostic): boolean => {
    if (d.code !== 7016 || d.fileName === undefined || d.pos === undefined || d.end === undefined) return false;
    const sf = p.getSourceFile(d.fileName);
    if (!sf) return false;
    const spec = sf.text.slice(d.pos, d.end).replace(/^['"]|['"]$/g, "");
    const prefix = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
    return isWorkspacePackageName(prefix);
  };
  const errorsOf = (p: ts.Program): ts.Diagnostic[] => {
    const all = ts.getPreEmitDiagnostics(p);
    // First pass: every comment-side 2300's (file, name) — the partners
    // the second pass forgives.
    const commentDup = new Set<string>();
    for (const d of all) {
      if (d.code !== 2300 || d.fileName === undefined || d.pos === undefined || d.end === undefined) continue;
      if (!isJsSourceFileName(d.fileName)) continue;
      const sf = p.getSourceFile(d.fileName);
      if (sf && insideBlockComment(sf.text, d.pos)) commentDup.add(`${d.fileName}:${sf.text.slice(d.pos, d.end)}`);
    }
    // TS2307 over an ASSET specifier: the preflight's asset resolution
    // answers the import (the checker has no ambient for it — the bare
    // package/extension pair carries no typings by design), so the
    // checker's refusal must not gate the compile.
    const assetImportSuppressed = (d: ts.Diagnostic): boolean => {
      if (d.code !== 2307 || d.fileName === undefined || d.pos === undefined || d.end === undefined) return false;
      const sf = p.getSourceFile(d.fileName);
      if (!sf) return false;
      const spec = sf.text.slice(d.pos, d.end).replace(/^['"]|['"]$/g, "");
      return resolveRelativeAsset(sf.fileName, spec) !== null || resolveBareAsset(sf.fileName, spec) !== null;
    };
    // TS2578 (unused '@ts-expect-error'): the directive is the AUTHOR'S claim about THEIR toolchain's
    // behavior — scriptc's adopted type world diverges (their lib surface, their tsgo snapshot), so the
    // expected error may legitimately not occur here. An unused directive never indicates a broken program
    // (the code typechecks clean — that is what "unused" means), and the binary is unaffected. Noise, not a gate.
    const unusedExpectErrorSuppressed = (d: ts.Diagnostic): boolean => d.code === 2578;
    // A KERNEL package's own .d.ts (effect's reach for DOM/esnext names under the fallback surface): the kernel maps the
    // types it serves by provenance and never runs the package, so its internals are not the program's gate (scoped skipLibCheck).
    const kernelDeclarationSuppressed = (d: ts.Diagnostic): boolean => d.fileName !== undefined && d.fileName.endsWith(".d.ts") && [...KERNEL_MODULES].some((name) => d.fileName!.includes(`/node_modules/${name}/`));
    return all.filter(
      (d) =>
        d.category === ts.DiagnosticCategory.Error &&
        !kernelDeclarationSuppressed(d) &&
        !suppressedJsStrictness7(d) &&
        !npmStaticFileSuppressed(d) &&
        !nodeModulesJsSuppressed(d) &&
        !namespaceCalleeSuppressed(p, d) &&
        !workspaceImplicitAnySuppressed(p, d) &&
        !assetImportSuppressed(d) &&
        !unusedExpectErrorSuppressed(d) &&
        !jsdocTypeSuppressed(p, d, commentDup),
    );
  };

  // Lowering overrides (JSON.parse(): unknown, the Promise executor shape)
  // are tighter than the project's standard lib. If they introduce errors,
  // consult the same program without those overrides: a clean project passes
  // preflight and meets any checked-cast fences during lowering; a broken
  // project reports its own reproducible tsc errors. Release this temporary
  // checker before prefetch/lowering; only copied diagnostics survive.
  const tscErrors = errorsOf(program);
  if (tscErrors.length > 0) {
    load.withProjectWorld((view) => {
      for (const d of errorsOf(view)) diags.push(toPassthrough(d));
    });
  }

  return diags;
}
