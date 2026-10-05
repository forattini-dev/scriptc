import type { IrExpr } from "../../ir/ir.js";
import type { RustExpressionContext } from "./expression-context.js";
import type { RustLibCallContext } from "./lib-calls.js";
import { emitErrorMessageRead } from "./error-message-getters.js";
import { rustJsString } from "./string-literals.js";

/** Preserve expression substitutions when adapting the library-call seam. */
export function rustLibCallContext(context: RustExpressionContext, emitExpr: (value: IrExpr) => string): RustLibCallContext {
  return {
    nextTemporary: () => context.nextName("sc_rt"), emitExpr,
    unsupported: (kind, loc) => context.unsupported(kind, loc),
    dynTypeName: () => context.dynTypeName(),
    record: (id, loc) => {
      const record = context.records.get(id);
      if (record === undefined) context.unsupported(`unknown record shape '${id}'`, loc);
      return record;
    },
    union: (id, loc) => context.union(id, loc), unionName: id => context.unionName(id), unionVariant: tag => context.unionVariant(tag),
    stripCasts: value => context.stripCasts(value), hasClassMeta: name => context.classMeta.has(name),
    errorMessageRead: (className, receiver) => context.classMeta.has(className) ? emitErrorMessageRead(context, context.classMetaOf(className), className, receiver) : null,
    classFieldName: (className, fieldName, loc) => context.classFieldName(className, fieldName, loc),
    classMetaOf: (className, loc) => context.classMetaOf(className, loc),
    hasErrorClassRoots: () => context.errorClassRoots().length > 0, errorValueName: () => context.errorValueName(),
    rustString: value => context.rustString(value), rustType: (type, loc) => context.rustType(type, loc),
    emitPromiseFromSync: (args, operation) => context.emitPromiseFromSync(args, operation),
    emitFileHandleTransferPromise: value => context.emitFileHandleTransferPromise(value),
    emitFsRenameCallback: value => context.emitFsRenameCallback(value),
    emitClosureDispatch: (callee, type, args, loc) => context.emitClosureDispatch(callee, type, args, loc),
    functionIdentity: (value, type, loc, borrowed = false) => {
      const shape = context.closureShapeForType(type, loc);
      return `sc_closure_identity_${shape.index}(${borrowed ? value : `&${value}`})`;
    },
    emitEventEmitterCall: value => context.emitEventEmitterCall(value),
    isEdgeValue: type => context.isEdgeValue(type), isUnit: type => context.isUnit(type),
    familyName: (id, loc) => context.familyName(id, loc), familyOf: (id, loc) => context.familyOf(id, loc), familyTargetOf: name => context.familyTargetOf(name),
    emitDynCheckValue: (type, value, loc) => context.emitDynCheckValue(type, value, loc), emitDynFromValue: (type, value, loc) => context.emitDynFromValue(type, value, loc),
    classNameArms: (className, loc) => context.classSubtree(context.classMetaOf(className, loc)).map(candidate =>
      `${candidate.pre} => ${rustJsString(candidate.def.jsName ?? "", text => context.rustString(text))},`
    ).join(" "),
    constructorIdentityArms: (className, loc) => context.classSubtree(context.classMetaOf(className, loc)).map(candidate =>
      `${candidate.pre} => "${context.rustString(`%${candidate.def.name}.constructor`)}",`
    ).join(" "),
  };
}
