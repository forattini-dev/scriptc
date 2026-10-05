import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, F64, STRING, shapeHasAccessorSlots, type IrExpr, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";

/** Promise-based OS lookups, not DNS wire queries. Unsupported options
 * keep a named fence; admitting the module does not admit every export. */
export function registerPromisifiedDnsLookup(lowerer: Lowerer, nameNode: ts.Node, target: { module: string; member: string } | null): boolean {
  if (target?.module !== "dns" || target.member !== "lookup") return false;
  if (!ts.isIdentifier(nameNode) || !ts.isVariableDeclaration(nameNode.parent) ||
      !ts.isVariableDeclarationList(nameNode.parent.parent) || !(nameNode.parent.parent.flags & ts.NodeFlags.Const)) {
    lowerer.noLowering("a mutable promisified dns.lookup binding", nameNode, "declare a const binding and call it directly");
  }
  const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
  if (symbol) lowerer.promisifiedDnsLookup.add(symbol);
  return true;
}

export function lowerDnsPromisesCall(lowerer: Lowerer, call: ts.CallExpression, member: string, loc: SrcLoc, promisified = false): IrExpr {
  if (member !== "lookup") lowerer.noLowering(`dns/promises.${member}`, call, "lookup is the implemented native promise member");
  const hostnameNode = call.arguments[0];
  if (hostnameNode === undefined || call.arguments.length > 2 || call.arguments.some(ts.isSpreadElement)) {
    lowerer.noLowering("dns/promises.lookup argument count", call, "use lookup(hostname[, options])");
  }
  const stmts: IrStmt[] = [];
  // Evaluate the original arguments, including the entire options object,
  // exactly once in source order. Only pure closed-record reads follow.
  const stage = (value: IrExpr): IrExpr => {
    const local = lowerer.declareHiddenLocal("%dnsArg", value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
    return varRef(local.id, value.type, loc);
  };
  const hostname = stage(lowerer.lowerExprExpecting(hostnameNode, STRING));
  let family: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
  let familyName = "family";
  const options = call.arguments[1];
  if (options !== undefined) {
    const value = stage(lowerer.lowerExpr(options));
    if (value.type.kind === "f64") family = value;
    else if (value.type.kind === "undefinedT") { /* omitted options */ }
    else if (value.type.kind === "record") {
      familyName = "options.family";
      const shape = lowerer.shapes.get(value.type.shapeId);
      if (!shape || shape.tuple || shape.indexValue || shapeHasAccessorSlots(shape)) {
        lowerer.noLowering("dns/promises.lookup options shape", options, "use a closed plain record without accessors or an index signature");
      }
      for (const field of shape.fields) {
        if (field.name !== "family") {
          lowerer.noLowering(`dns/promises.lookup option '${field.name}'`, options, "the implemented options are family 0, 4 or 6; all, hints and ordering keep explicit refusals");
        }
        const read: IrExpr = { kind: "recordGet", obj: value, shapeId: shape.id, field: field.name, type: field.type, loc };
        if (field.type.kind === "f64") family = read;
        else if (field.type.kind === "undefinedT" || field.type.kind === "nullT") { /* default family */ }
        else if (field.type.kind === "union") {
          const arms = lowerer.unions.get(field.type.unionId)?.arms;
          const tag = lowerer.armTag(field.type.unionId, F64);
          if (tag < 0 || !arms?.every(arm => ["f64", "undefinedT", "nullT"].includes(arm.kind))) {
            lowerer.noLowering("dns/promises.lookup family type", options, "use a numeric, nullable or optional numeric family");
          }
          family = { kind: "ternary", cond: { kind: "unionIsTag", unionId: field.type.unionId, tag, value: read, negated: false, type: BOOL, loc },
            then: { kind: "unionNarrow", unionId: field.type.unionId, tag, value: read, type: F64, loc }, else_: family, type: F64, loc };
        } else lowerer.noLowering("dns/promises.lookup family type", options, "use a numeric family");
      }
    } else if (value.type.kind === "dyn") {
      // An open JS literal may use native dynamic storage while its
      // source still proves a closed data-only options family. Do not
      // accidentally admit unknown index signatures or other DNS options.
      const source = lowerer.mapTypeOf(lowerer.typeOf(options));
      const shape = source?.kind === "record" ? lowerer.shapes.get(source.shapeId) : undefined;
      const checkerType = lowerer.typeOf(options);
      const symbol = checkerType.getSymbol();
      const emptyLiteral = symbol !== undefined && lowerer.checker.declarationsOf(symbol).some(ts.isObjectLiteralExpression) &&
        lowerer.checker.getPropertiesOfType(checkerType).length === 0;
      if ((!shape && !emptyLiteral) ||
          (shape && (shape.tuple || shape.indexValue || shapeHasAccessorSlots(shape) || shape.fields.some(field => field.name !== "family")))) {
        lowerer.noLowering("dns/promises.lookup options shape", options, "use a source-proven plain options object with only family");
      }
      familyName = "options.family";
      const read: IrExpr = { kind: "dynKeyGet", value, key: { kind: "strLit", value: "family", type: STRING, loc }, type: DYN, loc };
      family = { kind: "libCall", fn: "dns.lookupFamily", args: [read], type: F64, loc };
    } else lowerer.noLowering("dns/promises.lookup options shape", options, "pass a numeric family or a closed plain record");
  }
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (result?.kind !== "promise" || result.inner.kind !== "record") {
    lowerer.noLowering("dns/promises.lookup result shape", call, "the result is a Promise of an address/family record");
  }
  const lookup: IrExpr = { kind: "libCall", fn: promisified ? "dns.lookupAsync" : "dns.promises.lookup", args: [hostname, family,
    { kind: "strLit", value: familyName, type: STRING, loc }], type: result, loc };
  return { kind: "seqExpr", stmts, result: lookup, type: result, loc };
}
