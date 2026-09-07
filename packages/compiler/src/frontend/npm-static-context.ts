/* A published callback signature can contextualize TS parameters even when
 * runtime JS inference returns any (RPC and JSON boundaries commonly do).
 * Recheck the original authoring surface before admitting precisely that
 * loss of context. No declaration types enter the native program: its any
 * values still go through checked dynamic lowering and ordinary fences. */
import * as ts from "./ts7/adapter.js";
import { checkPreflight, loadProgram } from "./program.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";

type LoadedProgram = ReturnType<typeof loadProgram>;
const siteKey = (file: string, start: number, end: number): string => `${file}:${start}:${end}`;

function callbackParameter(program: ts.Program, d: ts.Diagnostic): boolean {
  if (d.fileName === undefined) return false;
  const file = program.getSourceFile(d.fileName);
  if (file === undefined) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || node.end < d.pos || node.getStart() > d.end) return;
    if (ts.isParameter(node) && node.type === undefined &&
        node.name.getStart() <= d.pos && node.name.end >= d.end) {
      let callback: ts.Node = node.parent;
      if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
        while (ts.isParenthesizedExpression(callback.parent)) callback = callback.parent;
        const call = callback.parent;
        found = ts.isCallExpression(call) && call.arguments.some((arg) => arg === callback);
      }
    }
    if (!found) node.forEachChild(visit);
  };
  visit(file);
  return found;
}

/** Match numeric checker codes and AST parameter sites, never message text.
 * Every remaining preflight error must qualify; unrelated errors preserve
 * the existing per-package fallback policy. */
function onlyCallbackContextErrors(load: LoadedProgram, diags: readonly ScrDiagnostic[]): boolean {
  if (diags.length === 0 || diags.some((d) => d.code !== "SC0001")) return false;
  const eligible = new Set(load.program.getSemanticDiagnostics()
    .filter((d) => (d.code === 7006 || d.code === 7031) && callbackParameter(load.program, d))
    .map((d) => siteKey(d.fileName ?? "", d.pos, d.end)));
  return diags.every((d) => eligible.has(siteKey(d.loc.file, d.loc.start, d.loc.end)));
}

/** On a retry, owns/disposes the input load and returns a freshly restored
 * native program. Loading the declaration view resets per-load npm state,
 * so even a rejected retry must restore that state before ordinary fallback.
 * Null means no retry was needed and the caller still owns its input. */
export function retryNpmCallbackContext(
  entryPath: string, packages: ReadonlySet<string>, load: LoadedProgram,
  preflight: ScrDiagnostic[], externalTypes?: Readonly<Record<string, string>>,
): { load: LoadedProgram; preflight: ScrDiagnostic[] } | null {
  if (packages.size === 0 || !onlyCallbackContextErrors(load, preflight)) return null;
  load.dispose();
  const authoring = loadProgram(entryPath, { externalTypes });
  let authoringPassed: boolean;
  try { authoringPassed = checkPreflight(authoring).length === 0; }
  finally { authoring.dispose(); }

  const native = loadProgram(entryPath, { npmStatic: packages, externalTypes });
  const fresh = checkPreflight(native);
  return {
    load: native,
    preflight: authoringPassed && onlyCallbackContextErrors(native, fresh) ? [] : fresh,
  };
}
