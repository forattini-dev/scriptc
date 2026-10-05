import type { IrExpr, IrFunction, IrModule, SrcLoc } from "../../ir/ir.js";
import { RUNTIME_ERROR_CLASSES } from "../../ir/ir.js";

/** Refuse unqualified shapes before any native source stack can diverge. */
export function rejectUnqualifiedSourceStacks(module: IrModule, unsupported: (reason: string, loc: SrcLoc) => never): void {
  if (module.sourceStackFiles === undefined) return;
  const suspended = module.functions.find(fn => fn.async || fn.generator !== undefined);
  if (suspended) unsupported("Error source stacks with async or generator functions", suspended.loc);
  const classes = new Map(module.classes?.map(cls => [cls.name, cls]));
  for (const cls of classes.values()) {
    let ancestor = cls;
    const visited = new Set<string>();
    while (!RUNTIME_ERROR_CLASSES.has(ancestor.name) && ancestor.base && !visited.has(ancestor.name)) {
      visited.add(ancestor.name);
      const base = classes.get(ancestor.base);
      if (!base) break;
      ancestor = base;
    }
    if (!RUNTIME_ERROR_CLASSES.has(ancestor.name)) continue;
    if (cls.methods?.some(method => method === "get:stack" || method === "set:stack")) unsupported("shadowed Error stack property", cls.loc);
    if (cls.methods?.some(method => method === "get:name" || method === "get:message")) unsupported("Error stack headers with accessors", cls.loc);
  }
}

export interface SourceStackContext {
  module(): IrModule;
  currentFunction(): IrFunction | null;
  emitExpr(expr: IrExpr): string;
  emitWithValues(expr: IrExpr, values: readonly (readonly [IrExpr, string])[]): string;
  nextName(): string;
  rustString(value: string): string;
}

/** Evaluate arguments before entering a callsite frame: a capture during an
 * argument must not see a pending callee's frame. No Rust backtraces or engine. */
export function emitSourceStackCall(context: SourceStackContext, expr: IrExpr, emit: () => string): string {
  const files = context.module().sourceStackFiles;
  const fn = context.currentFunction();
  if (!files || !fn || !["call", "callValue", "virtualCall", "new", "libCall"].includes(expr.kind)) return emit();
  if (expr.kind === "libCall" && expr.fn === "error.stack") return emit();
  const classConstructor = fn.name.startsWith("%") && fn.name.endsWith(".constructor") ? context.module().classes?.find(cls => `%${cls.name}.constructor` === fn.name) : undefined;
  const file = files.find(candidate => candidate.file === expr.loc.file);
  if (!file) return emit();
  const name = classConstructor ? `new ${classConstructor.jsName ?? classConstructor.name}` : fn.name.startsWith("%init.") ? (file.displayFile.startsWith("file:") ? "" : "Object.<anonymous>") : fn.name.startsWith("%") ? null : fn.name;
  if (name === null) return emit();
  const position = file.callOffsets?.find(site => site.start === expr.loc.start && site.end === expr.loc.end)?.position ?? expr.loc.start;
  let lineIndex = 0;
  while (lineIndex + 1 < file.lineStarts.length && (file.lineStarts[lineIndex + 1] ?? Infinity) <= position) lineIndex++;
  const lineStart = file.lineStarts[lineIndex] ?? 0;
  const inputs: IrExpr[] = [];
  if (expr.kind === "callValue") inputs.push(expr.callee);
  if ("args" in expr && Array.isArray(expr.args)) inputs.push(...expr.args);
  const values: Array<readonly [IrExpr, string]> = [];
  const declarations: string[] = [];
  for (const input of inputs) {
    const local = context.nextName();
    declarations.push(`let ${local} = ${context.emitExpr(input)};`);
    values.push([input, local]);
  }
  const body = context.emitWithValues(expr, values);
  const guard = context.nextName();
  return `{ ${declarations.join(" ")} let ${guard} = runtime::source_stack_push("${context.rustString(fn.name)}", "${context.rustString(name)}", "${context.rustString(file.displayFile)}", ${lineIndex + 1}, ${position - lineStart + 1}); ${body} }`;
}
