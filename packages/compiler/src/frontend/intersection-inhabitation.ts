import * as ts from "./ts7/adapter.js";

function literalDomain(type: ts.Type, checker: ts.TypeChecker): Set<string> | null {
  if (type.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) {
    return new Set([checker.typeToString(type)]);
  }
  if (!type.isUnionType()) return null;
  const values = new Set<string>();
  for (const part of ts.constituentTypes(type)) {
    const domain = literalDomain(part, checker);
    if (domain === null) return null;
    for (const value of domain) values.add(value);
  }
  return values;
}

/** tsgo may expose an unreduced intersection arm whose discriminants cannot
 * coexist. Prove emptiness from required literal fields, never from formatting
 * the entire type as "never". Optional-only conflicts remain inhabited. */
export function uninhabitedIntersection(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.flags & ts.TypeFlags.Never) return true;
  if (!type.isIntersectionType()) return false;
  const fields = new Map<string, { domain: Set<string>; required: boolean }>();
  for (const part of ts.constituentTypes(type)) {
    for (const property of checker.getPropertiesOfType(part)) {
      const domain = literalDomain(checker.getTypeOfSymbol(property), checker);
      if (domain === null) continue;
      const required = (property.flags & ts.SymbolFlags.Optional) === 0;
      const previous = fields.get(property.name);
      if (previous === undefined) fields.set(property.name, { domain, required });
      else {
        previous.required ||= required;
        for (const value of previous.domain) if (!domain.has(value)) previous.domain.delete(value);
        if (previous.required && previous.domain.size === 0) return true;
      }
    }
  }
  return false;
}
