/* Recheck the original authoring surface before admitting lost callback
 * context or a JS object's null-default inference artifact. No declaration
 * value types enter the native program: runtime values still meet native
 * lowering's ordinary checks, including its checked-dynamic typed exits. */
import * as ts from "./ts7/adapter.js";
import { checkPreflight, loadProgram } from "./program.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { npmStaticPackageOfPath } from "./npm-static.js";
import { nullDefaultElement, nullDefaultPattern } from "./null-default-pattern.js";

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

/** Only a direct object argument's named null-default slot qualifies. */
function nullDefaultArgument(program: ts.Program, d: ts.Diagnostic): boolean {
  if (d.code !== 2322 || d.fileName === undefined) return false;
  const file = program.getSourceFile(d.fileName);
  if (file === undefined) return false;
  const checker = program.getTypeChecker();
  let found = false;
  ts.walkPreorder(file, (node) => {
    if (found) return "stop";
    if (node.end < d.pos || node.getStart() > d.end) return "skip";
    if (!ts.isPropertyAssignment(node) || !ts.isObjectLiteralExpression(node.parent) ||
        (!ts.isIdentifier(node.name) && !ts.isStringLiteralLike(node.name))) return undefined;
    if (d.pos < node.name.getStart() || d.end > node.name.end) return undefined;
    const argument = node.parent;
    const call = argument.parent;
    if (!ts.isCallExpression(call) && !ts.isNewExpression(call)) return undefined;
    const index = call.arguments?.indexOf(argument) ?? -1;
    if (index < 0) return undefined;
    const signature = checker.getResolvedSignature(call);
    const declaration = signature && checker.signatureDeclaration(signature);
    if (declaration === undefined || !ts.isFunctionLike(declaration) ||
        npmStaticPackageOfPath(declaration.getSourceFile().fileName) === null) return undefined;
    const parameter = declaration.parameters[index];
    const pattern = parameter && nullDefaultPattern(parameter);
    if (!pattern) return undefined;
    const name = node.name.text;
    found = pattern.elements.some((element) => {
      if (!nullDefaultElement(element) || element.name === undefined) return false;
      const key = element.propertyName ?? element.name;
      if (key === undefined || (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) || key.text !== name) return false;
      const type = checker.getTypeAtLocation(element.name);
      const arms = type.flags & ts.TypeFlags.Union ? ts.constituentTypes(type) : [type];
      return arms.every((arm) => (arm.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0);
    });
    return found ? "stop" : undefined;
  });
  return found;
}

/** Every remaining error must match numeric codes and AST input sites.
 * Unrelated errors retain the existing per-package fallback policy. */
function onlyInferredContextErrors(load: LoadedProgram, diags: readonly ScrDiagnostic[]): boolean {
  if (diags.length === 0 || diags.some((d) => d.code !== "SC0001")) return false;
  const eligible = new Set(load.program.getSemanticDiagnostics()
    .filter((d) => ((d.code === 7006 || d.code === 7031) && callbackParameter(load.program, d)) ||
      nullDefaultArgument(load.program, d))
    .map((d) => siteKey(d.fileName ?? "", d.pos, d.end)));
  return diags.every((d) => eligible.has(siteKey(d.loc.file, d.loc.start, d.loc.end)));
}

/** On a retry, owns/disposes the input load and returns a freshly restored
 * native program. Loading the declaration view resets per-load npm state,
 * so even a rejected retry must restore that state before ordinary fallback.
 * Null means no retry was needed and the caller still owns its input. */
export function retryNpmInferredContext(
  entryPath: string, packages: ReadonlySet<string>, load: LoadedProgram,
  preflight: ScrDiagnostic[], externalTypes?: Readonly<Record<string, string>>,
): { load: LoadedProgram; preflight: ScrDiagnostic[] } | null {
  if (packages.size === 0 || !onlyInferredContextErrors(load, preflight)) return null;
  load.dispose();
  const authoring = loadProgram(entryPath, { externalTypes });
  let authoringPassed: boolean;
  try { authoringPassed = checkPreflight(authoring).length === 0; }
  finally { authoring.dispose(); }

  const native = loadProgram(entryPath, { npmStatic: packages, externalTypes });
  const fresh = checkPreflight(native);
  return {
    load: native,
    preflight: authoringPassed && onlyInferredContextErrors(native, fresh) ? [] : fresh,
  };
}
