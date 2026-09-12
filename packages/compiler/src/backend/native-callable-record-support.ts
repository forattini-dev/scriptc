import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { IrExpr, IrModule, IrType, SrcLoc } from "../ir/ir.js";
import { nativeIndexedRecordValue, nativeRecordCheckSupported } from "../ir/native-record.js";

/** C/LLVM's record builders copy fields. Newly admitted callable record
 * exits require Rust's shared map instead of accepting a different identity. */
export function nativeCallableRecordBackendDiagnostics(mod: IrModule, backend: "c" | "llvm"): ScrDiagnostic[] {
  const records = new Map(mod.records?.map(record => [record.id, record]));
  const unions = new Map(mod.unions?.map(union => [union.id, union]));
  const requiresSharedExit = (type: IrType | undefined, visiting = new Set<string>(), fromDynamic = true): boolean => {
    // Checking a callable boxes its typed arguments and checks its result.
    // A callback argument reverses direction again; do not mistake a supported
    // outbound record snapshot for a new shared record extraction.
    if (type?.kind === "func") return type.params.some(param => requiresSharedExit(param, visiting, !fromDynamic)) || requiresSharedExit(type.ret, visiting, fromDynamic);
    if (type?.kind === "union") return unions.get(type.unionId)?.arms.some(arm => requiresSharedExit(arm, visiting, fromDynamic)) ?? false;
    if (type?.kind !== "record") return false;
    const key = `${fromDynamic ? "check" : "box"}:${type.shapeId}`;
    if (visiting.has(key)) return false;
    visiting.add(key);
    const shape = records.get(type.shapeId);
    const shared = (!fromDynamic || nativeRecordCheckSupported(type, id => records.get(id), id => unions.get(id))) &&
      ((shape?.indexValue !== undefined && requiresSharedExit(shape.indexValue, visiting, fromDynamic)) ||
        (shape?.fields.some(field => (fromDynamic && (field.type.kind === "func" || field.type.kind === "dyn")) || requiresSharedExit(field.type, visiting, fromDynamic)) ?? false));
    visiting.delete(key);
    return shared;
  };
  let loc: SrcLoc | undefined;
  let indexedCast = false;
  let sharedOperation: string | undefined;
  const visit = (value: unknown): void => {
    if (loc || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as { kind?: string; callee?: string; type?: IrType; loc?: SrcLoc; obj?: { kind?: string }; left?: { kind?: string; value?: { type: IrType } }; right?: { kind?: string; value?: { type: IrType } }; value?: IrExpr };
    const indexed = (type: IrType | undefined) => type !== undefined && nativeIndexedRecordValue(type, id => records.get(id), id => unions.get(id)) !== undefined;
    if ((node.kind === "call" && node.callee?.startsWith("%record.open.delete.")) ||
      (node.kind === "dynScalarEq" && [node.left, node.right].some(side => side?.kind === "dynFrom" && side.value?.type.kind === "record"))) {
      sharedOperation = node.kind === "call" ? "dictionary deletion" : "record identity comparisons";
      loc = node.loc ?? { file: mod.sourceFile, start: 0, end: 0 };
      return;
    }
    if (node.kind === "dynCheck" && node.value?.kind === "dynKeyGet" && node.value.value.kind === "dynFrom" &&
      node.value.value.value.type.kind === "record" && node.type && nativeRecordCheckSupported(node.type, id => records.get(id), id => unions.get(id))) {
      sharedOperation = "heterogeneous record keyed reads";
      loc = node.loc ?? { file: mod.sourceFile, start: 0, end: 0 };
      return;
    }
    if (node.kind === "dynCheck" && node.value?.kind === "dynFrom" && indexed(node.type) && indexed(node.value.value?.type)) {
      indexedCast = true;
      loc = node.loc ?? { file: mod.sourceFile, start: 0, end: 0 };
      return;
    }
    // Boxed functions generate call thunks that check their incoming dynamic
    // arguments, including functions stored inside boxed records.
    if ((node.kind === "dynCheck" && requiresSharedExit(node.type)) ||
      (node.kind === "dynFrom" && requiresSharedExit(node.value?.type, new Set(), false))) {
      if (node.type?.kind === "record" && records.get(node.type.shapeId)?.fields.some(field => field.type.kind === "dyn")) sharedOperation = "record exits with unknown fields";
      loc = node.loc ?? { file: mod.sourceFile, start: 0, end: 0 };
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(mod);
  return loc ? [{ code: "SC3001", loc,
    message: `the ${backend} backend does not support shared ${sharedOperation ?? (indexedCast ? "indexed record casts" : "callable record exits")} yet; use --backend rust`,
  }] : [];
}
