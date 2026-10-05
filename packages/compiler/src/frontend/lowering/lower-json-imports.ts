import * as ts from "../ts7/adapter.js";
import { locOf, isRequireStatement, requireSpecOf, resolveImport } from "../program.js";
import { invalidJsonModuleDiag } from "../../diagnostics/diagnostic.js";
import { BOOL, type IrGlobal } from "../../ir/ir.js";
import { PoisonError, boundIdentifiersOf, type Lowerer } from "./lowerer.js";
import type { FileParts } from "./lower-modules.js";

interface JsonBindingSite {
  name: ts.Identifier | ts.ObjectBindingPattern;
  site: ts.Node;
  spec: string | null;
  declaration?: ts.VariableDeclaration;
}

/** The JSON-module BINDING SITES of one file: the ESM default import
 * (`import pkg from "../package.json"`) and its CommonJS twin
 * (`const pkg = require("./codes.json")`, including flat object patterns).
 * ESM named/namespace imports and bare require calls retain their fences. */
function jsonBindingSitesOf(sf: ts.SourceFile): JsonBindingSite[] {
  const out: JsonBindingSite[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      if (clause?.name && clause.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
        out.push({ name: clause.name, site: stmt, spec: stmt.moduleSpecifier.text });
      }
      continue;
    }
    // `const data = require("./x.json")` — preflight (the require-of-JSON
    // branch) admits identifiers and flat object patterns; JSON documents
    // are data leaves, not executable module edges.
    if (!isRequireStatement(stmt) || !ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      const spec = decl.initializer !== undefined ? requireSpecOf(decl.initializer) : null;
      if (spec !== null && (ts.isIdentifier(decl.name) || ts.isObjectBindingPattern(decl.name))) {
        out.push({ name: decl.name, site: decl, spec, declaration: decl });
      }
    }
  }
  return out;
}

/** Bake JSON-module data into a document global shared by its resolved
 * path. Each importer's prelude checks one initialization guard, so later
 * imports preserve mutations and object identity instead of re-baking the
 * data. Identifier bindings alias the cached document; flat require
 * patterns have separate storage populated at the declaration position.
 * Unbakeable shapes and invalid JSON keep their binding-site diagnostics.
 * Preflight fences ESM named/namespace imports and bare require calls. */
export function collectJsonImports(lowerer: Lowerer, parts: FileParts[]): void {
  // The module cache in miniature: one global per DOCUMENT, whatever the
  // spelling that reached it. The ESM form's alias symbol is the natural
  // key (importers of the same document alias one symbol); the CommonJS
  // require binding may be a plain variable, so the document's path keys
  // the sharing and BOTH symbols route reads to the one global.
  const byDocument = new Map<string, { value: IrGlobal; initialized: IrGlobal }>();
  for (const fp of parts) {
    for (const { name, site, spec, declaration } of jsonBindingSitesOf(fp.sf)) {
      const nameSym = ts.isIdentifier(name) ? lowerer.checker.getSymbolAtLocation(name) : undefined;
      if (ts.isIdentifier(name) && !nameSym) continue;
      const target = nameSym && (nameSym.flags & ts.SymbolFlags.Alias) ? lowerer.checker.getAliasedSymbol(nameSym) : null;
      let jsonSf = target ? lowerer.checker.declarationsOf(target)[0]?.getSourceFile() : undefined;
      if ((!jsonSf || !jsonSf.fileName.endsWith(".json")) && spec !== null) {
        // The require form: tsgo need not model the binding as an alias
        // onto the JSON module, so the specifier resolves directly.
        jsonSf = resolveImport(lowerer.program, fp.sf, spec) ?? undefined;
      }
      if (!jsonSf || !jsonSf.fileName.endsWith(".json")) continue;
      try {
        const tsType = lowerer.typeOf(name);
        const mapped = lowerer.mapTypeOf(tsType);
        if (!mapped || !lowerer.comptimeBakeable(mapped)) {
          lowerer.badType(name, tsType);
        }
        // tsgo tolerates JSON shapes strict JSON.parse rejects (a leading
        // `//` comment — importAttributes11), so no SC0001 guarantees a
        // clean document: a failing parse gates at the binding site
        // (Node refuses to load the module at runtime too).
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonSf.text);
        } catch (e) {
          lowerer.pushDiag(invalidJsonModuleDiag(
            jsonSf.fileName,
            e instanceof Error ? e.message : String(e),
            locOf(site),
          ));
          throw new PoisonError();
        }
        const value = lowerer.comptimeValueToIr(parsed, mapped, "$", name);
        let document = byDocument.get(jsonSf.fileName);
        if (!document) {
          const g: IrGlobal = {
            id: `%g.json.${lowerer.globalsList.length}`,
            name: ts.isIdentifier(name) ? name.text : "%json.document",
            type: mapped,
            mutable: false,
          };
          const initialized: IrGlobal = {
            id: `${g.id}.initialized`, name: "%json.initialized", type: BOOL, mutable: true,
          };
          document = { value: g, initialized };
          byDocument.set(jsonSf.fileName, document);
          lowerer.globalsList.push(g, initialized);
        }
        const g = document.value;
        if (target !== null) lowerer.globalsBySymbol.set(target, g);
        // The BINDING's own symbol too: a require declaration tsgo does
        // not alias onto the module has nothing else for reads to find.
        if (nameSym) lowerer.globalsBySymbol.set(nameSym, g);
        if (ts.isObjectBindingPattern(name) && declaration) {
          lowerer.jsonRequireBindings.set(declaration, g);
          const mutable = (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0;
          for (const identifier of boundIdentifiersOf(name)) {
            const symbol = lowerer.checker.getSymbolAtLocation(identifier);
            if (!symbol || lowerer.globalsBySymbol.has(symbol)) continue;
            const binding: IrGlobal = {
              id: `%g.json.binding.${lowerer.globalsList.length}`, name: identifier.text,
              type: lowerer.irTypeOf(identifier), mutable,
            };
            lowerer.globalsBySymbol.set(symbol, binding);
            lowerer.globalsList.push(binding);
          }
        }
        const actions = lowerer.jsonInitActions.get(fp.sf) ?? [];
        lowerer.jsonInitActions.set(fp.sf, actions);
        const loc = locOf(site);
        actions.push({
          kind: "if",
          cond: { kind: "unary", op: "!", operand: { kind: "varRef", localId: document.initialized.id, type: BOOL, loc }, type: BOOL, loc },
          then: [
            { kind: "assign", localId: g.id, value, loc },
            { kind: "assign", localId: document.initialized.id, value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
          ],
          else_: null, loc,
        });
      } catch (e) {
        if (!(e instanceof PoisonError)) throw e;
        // diagnostic already recorded; uses of the binding poison too
      }
    }
  }
}
