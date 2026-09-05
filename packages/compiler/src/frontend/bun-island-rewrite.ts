/**
 * Bun runtime modules inside EMBEDDED code under `--target bun`.
 *
 * `import { Database } from "bun:sqlite"` links against a module the
 * island cannot provide. Under Node the specifier is simply unknown; under
 * the bun target the honest answer is the static tier's own: the import
 * succeeds and every USE traps at runtime naming the member and the
 * module ("requires the Bun runtime"). The island prelude serves that
 * trap table as `globalThis.__scr_bun_trap(spec)`; ESM import syntax
 * cannot bind to a synthesized module's unknown export names, so this
 * rewrite turns each bun import declaration into reads of the table:
 *
 *   import D, { A, B as C } from "bun:x"; import * as ns from "bun:x";
 *   → const __scr_bun_N = globalThis.__scr_bun_trap("bun:x");
 *     const D = __scr_bun_N.default; const { A, B: C } = __scr_bun_N;
 *     const ns = __scr_bun_N;
 *
 * Imports hoist and `const` does not, so a use above the declaration
 * would differ — a shape the package code this serves never takes.
 * CommonJS `require("bun:x")` needs no rewrite: the island's require shim
 * answers it from the same table.
 */
import ts from "typescript5";

export function isBunModuleSpecifier(spec: string): boolean {
  return spec === "bun" || spec.startsWith("bun:");
}

/** The rewritten source plus the specifiers rewritten (for the coverage
 * inventory). */
export interface BunImportRewrite {
  source: string;
  specifiers: string[];
}

export function rewriteBunModuleImports(source: string, fileName: string): BunImportRewrite {
  if (!/\bbun\b/.test(source)) return { source, specifiers: [] };
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const edits: { start: number; end: number; text: string }[] = [];
  const specifiers = new Set<string>();
  let counter = 0;
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!isBunModuleSpecifier(spec)) continue;
    specifiers.add(spec);
    const clause = stmt.importClause;
    const temp = `__scr_bun_${counter++}`;
    const lines = [`const ${temp} = globalThis.__scr_bun_trap(${JSON.stringify(spec)});`];
    if (clause !== undefined && !clause.isTypeOnly) {
      if (clause.name !== undefined) lines.push(`const ${clause.name.text} = ${temp}.default;`);
      const bindings = clause.namedBindings;
      if (bindings !== undefined) {
        if (ts.isNamespaceImport(bindings)) {
          lines.push(`const ${bindings.name.text} = ${temp};`);
        } else {
          const names = bindings.elements
            .filter((e) => !e.isTypeOnly)
            .map((e) => (e.propertyName === undefined ? e.name.text : `${e.propertyName.text}: ${e.name.text}`));
          if (names.length > 0) lines.push(`const { ${names.join(", ")} } = ${temp};`);
        }
      }
    }
    edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: lines.join(" ") });
  }
  if (edits.length === 0) return { source, specifiers: [] };
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  out += source.slice(cursor);
  return { source: out, specifiers: [...specifiers].sort() };
}
