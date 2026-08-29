import type { IrModule, IrRecordShape, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import type { IrFuncType, RustClassMeta, RustClosureShape } from "./model.js";

export interface RustDynamicContext {
  usesDyn(): boolean;
  usesDynamicInvoke(): boolean;
  readonly closureShapes: ReadonlyMap<string, RustClosureShape>;
  readonly dynAdapterShapes: ReadonlySet<string>;
  readonly dynBoxedFunctionShapes: ReadonlySet<string>;
  readonly records: ReadonlyMap<string, IrRecordShape>;
  readonly unions: ReadonlyMap<string, IrUnionDef>;
  module(): IrModule;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextTemporary(): string;
  closureName(shape: RustClosureShape): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  dynFunctionCheckName(shape: RustClosureShape): string;
  dynFunctionVariant(shape: RustClosureShape): string;
  dynTypeName(): string;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  errorClassRoots(): RustClassMeta[];
  errorValueName(): string;
  hasEmbeddedModules(): boolean;
  isEdgeValue(type: IrType): boolean;
  isRustJsonCompatible(type: IrType, visiting?: Set<string>): boolean;
  isUnit(type: IrType): boolean;
  needsClone(type: IrType): boolean;
  rustString(value: string): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}
