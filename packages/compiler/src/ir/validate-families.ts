/* The IR rules of closure FAMILIES (generic function values). A family value carries one implementation's captures;
 * a family call names an instantiation every implementation has a compiled body for. */
import { IrExpr, IrFamily, IrLocal, IrType, SrcLoc, typeEquals } from "./ir.js";

export interface FamilyValidationCtx {
  families: Map<string, IrFamily>;
  locals: Map<string, IrLocal>;
  functions: ReadonlySet<string> | ReadonlyMap<string, unknown>;
  err: (message: string, loc: SrcLoc) => void;
  expectType: (expr: IrExpr, want: IrType, what: string) => void;
}

export function validateFamilyClosure(e: Extract<IrExpr, { kind: "familyClosure" }>, ctx: FamilyValidationCtx): void {
  const { families, locals, err } = ctx;
  const impl = families.get(e.familyId)?.impls.find((candidate) => candidate.name === e.impl);
  if (!impl) { err(`familyClosure over unknown family/implementation "${e.familyId}"/"${e.impl}"`, e.loc); return; }
  if (e.type.kind !== "genericFunc" || e.type.familyId !== e.familyId) err("familyClosure type must be its family's genericFunc", e.loc);
  if (e.captures.length !== impl.captures.length) err(`familyClosure ${e.impl}: ${e.captures.length} captures, expected ${impl.captures.length}`, e.loc);
  e.captures.forEach((id, i) => {
    const local = locals.get(id); const want = impl.captures[i];
    if (!local) err(`familyClosure capture of undeclared local "${id}"`, e.loc);
    else if (!local.boxed) err(`familyClosure capture "${id}" is not boxed`, e.loc);
    else if (want && !typeEquals(local.type, want.type)) err(`familyClosure capture "${id}" type ${local.type.kind} != ${want.type.kind}`, e.loc);
  });
}

export function validateCallFamily(e: Extract<IrExpr, { kind: "callFamily" }>, ctx: FamilyValidationCtx): void {
  const { families, functions, err, expectType } = ctx;
  const inst = families.get(e.familyId)?.instances.find((candidate) => candidate.key === e.instKey);
  if (!inst) { err(`callFamily over unknown family/instantiation "${e.familyId}"/"${e.instKey}"`, e.loc); return; }
  if (e.callee.type.kind !== "genericFunc" || e.callee.type.familyId !== e.familyId) err("callFamily callee must be the family's genericFunc", e.loc);
  if (inst.params.length !== e.args.length) err(`callFamily: ${e.args.length} args, expected ${inst.params.length}`, e.loc);
  e.args.forEach((a, i) => { const p = inst.params[i]; if (p) expectType(a, p, `callFamily arg ${i}`); });
  if (!typeEquals(e.type, inst.ret)) err(`callFamily type ${e.type.kind} != return ${inst.ret.kind}`, e.loc);
  inst.targets.forEach((target) => { if (!functions.has(target)) err(`callFamily target "${target}" is not a function of the module`, e.loc); });
}
