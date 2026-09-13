/* Closure FAMILIES, the checker-level half: the canonical identity of a generic function TYPE. Two values share a
 * family when their signatures agree up to type-parameter and parameter NAMES — an implementation `<T>(e: T) => …`
 * and the interface member `publish<E>(event: E): …` it fills. */
import * as ts from "./ts7/adapter.js";

export function familyIdOf(checker: ts.TypeChecker, type: ts.Type): string | null {
  const sigs = checker.getCallSignatures(type);
  if (sigs.length !== 1) return null;
  const sig = sigs[0]!;
  const tps = sig.getTypeParameters() ?? [];
  if (tps.length === 0) return null;
  const names = tps.map((tp) => tp.getSymbol()?.name ?? "?");
  const norm = (t: ts.Type): string => {
    let text = checker.typeToString(t);
    names.forEach((name, i) => { text = text.replace(new RegExp(`\\b${name}\\b`, "g"), `%${i}`); });
    return text;
  };
  const params = sig.getParameters().map((p) => {
    const decl = checker.valueDeclarationOf(p);
    const param = decl !== undefined && ts.isParameter(decl) ? decl : undefined;
    const optional = param !== undefined && (param.questionToken !== undefined || param.initializer !== undefined);
    const rest = param !== undefined && param.dotDotDotToken !== undefined;
    return `${rest ? "..." : ""}${norm(checker.getTypeOfSymbol(p))}${optional ? "?" : ""}`;
  });
  // Constraints are part of the callable contract. Erasing them merges
  // <T extends number> and <T extends { name: string }> implementations,
  // causing each body to compile against the other family's argument types.
  const constraints = tps.map((tp) => {
    const symbol = tp.getSymbol();
    const declaration = symbol && checker.declarationsOf(symbol).find(ts.isTypeParameterDeclaration);
    return declaration?.constraint ? norm(checker.getTypeFromTypeNode(declaration.constraint)) : "*";
  });
  const constraintKey = constraints.some((constraint) => constraint !== "*") ? `:${constraints.join(",")}` : "";
  return `<${tps.length}${constraintKey}>(${params.join(",")})=>${norm(checker.getReturnTypeOfSignature(sig))}`;
}
