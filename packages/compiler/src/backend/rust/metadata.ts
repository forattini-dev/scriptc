import type { IrClassDef, IrExpr, IrFunction, IrModule, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, typeKey } from "../../ir/nodes.js";
import { mangleClassStruct, mangleField, mangleFunction } from "../mangle.js";
import type { IrFuncType, RustClassMeta, RustClosureShape, RustVtSlot } from "./model.js";

export interface RustMetadataContext {
  readonly classMeta: ReadonlyMap<string, RustClassMeta>;
  readonly classes: ReadonlyMap<string, IrClassDef>;
  readonly closureShapes: ReadonlyMap<string, RustClosureShape>;
  readonly functions: ReadonlyMap<string, IrFunction>;
  readonly promiseRejectorTypes: ReadonlyMap<string, IrType[]>;
  readonly unions: ReadonlyMap<string, IrUnionDef>;
  module(): IrModule;
  nextName(prefix: string): string;
  defaultValue(type: IrType, loc: SrcLoc): string;
  isEdgeValue(type: IrType): boolean;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export class RustMetadata {
  constructor(private readonly context: RustMetadataContext) {}

  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape {
    const shape = this.context.closureShapes.get(typeKey(type));
    if (shape === undefined) this.context.unsupported(`function signature '${typeKey(type)}' without closure targets`, loc);
    return shape;
  }

  classDef(name: string, loc?: SrcLoc): IrClassDef {
    const cls = this.context.classes.get(name);
    if (cls === undefined) this.context.unsupported(`class '${name}'`, loc);
    return cls;
  }

  stripCasts(expr: IrExpr): IrExpr {
    let value = expr;
    while (value.kind === "upcast" || value.kind === "downcast") value = value.value;
    return value;
  }

  runtimeErrorAncestor(name: string): string | null {
    const seen = new Set<string>();
    let cls = this.context.classes.get(name);
    while (cls?.base !== undefined && !seen.has(cls.name)) {
      seen.add(cls.name);
      if (RUNTIME_ERROR_CLASSES.has(cls.base)) return cls.base;
      cls = this.context.classes.get(cls.base);
    }
    return null;
  }

  isEmitterClass(name: string): boolean {
    const seen = new Set<string>();
    let cls = this.context.classes.get(name);
    while (cls !== undefined && !seen.has(cls.name)) {
      seen.add(cls.name);
      if (cls.base === RUNTIME_EMITTER_CLASS) return true;
      cls = cls.base === undefined ? undefined : this.context.classes.get(cls.base);
    }
    return false;
  }

  runtimeStreamBase(name: string): "%Readable" | "%Writable" | "%Duplex" | "%Transform" | null {
    const runtimeBases = new Set(["%Readable", "%Writable", "%Duplex", "%Transform"]);
    const seen = new Set<string>();
    let cls = this.context.classes.get(name);
    while (cls?.base !== undefined && !seen.has(cls.name)) {
      seen.add(cls.name);
      if (runtimeBases.has(cls.base)) {
        return cls.base as "%Readable" | "%Writable" | "%Duplex" | "%Transform";
      }
      cls = this.context.classes.get(cls.base);
    }
    return null;
  }

  errorClassRoots(): RustClassMeta[] {
    return [...this.context.classMeta.values()].filter((meta) =>
      meta === meta.root && this.runtimeErrorAncestor(meta.def.name) !== null
    );
  }

  errorValueName(): string {
    return "sc_error_value";
  }

  errorValueVariant(meta: RustClassMeta): string {
    return `User${meta.root.pre}`;
  }

  runtimeErrorClassNames(name: string): string[] {
    const ancestor = this.runtimeErrorAncestor(name);
    if (ancestor === null) return [];
    const names: string[] = [];
    let current: string | null = ancestor;
    while (current !== null) {
      const error = RUNTIME_ERROR_CLASSES.get(current);
      if (error === undefined) break;
      names.push(error.lib);
      current = error.base;
    }
    return names;
  }

  runtimeErrorIsA(source: string, target: string): boolean {
    let current: string | null = source;
    while (current !== null) {
      if (current === target) return true;
      current = RUNTIME_ERROR_CLASSES.get(current)?.base ?? null;
    }
    return false;
  }

  classMetaOf(name: string, loc?: SrcLoc): RustClassMeta {
    const meta = this.context.classMeta.get(name);
    if (meta === undefined) this.context.unsupported(`class '${name}'`, loc);
    return meta;
  }

  classStructName(name: string, loc?: SrcLoc): string {
    const meta = this.classMetaOf(name, loc);
    return mangleClassStruct(meta.hierarchy ? meta.root.def.name : name);
  }

  hierarchyFields(root: RustClassMeta): { owner: RustClassMeta; field: IrClassDef["fields"][number] }[] {
    const fields: { owner: RustClassMeta; field: IrClassDef["fields"][number] }[] = [];
    const visit = (meta: RustClassMeta): void => {
      const inherited = meta.base?.def.fields.length ?? 0;
      for (const field of meta.def.fields.slice(inherited)) fields.push({ owner: meta, field });
      for (const child of meta.children) visit(child);
    };
    visit(root);
    return fields;
  }

  classSubtree(meta: RustClassMeta): RustClassMeta[] {
    return [...this.context.classMeta.values()].filter((candidate) =>
      candidate.root === meta.root && meta.pre <= candidate.pre && candidate.pre <= meta.post
    );
  }

  classAllocation(meta: RustClassMeta, args: readonly string[], loc: SrcLoc): string {
    const constructor = this.context.functions.get(`%${meta.def.name}.constructor`);
    if (constructor === undefined) this.context.unsupported(`missing constructor for '${meta.def.name}'`, loc);
    const object = this.context.nextName("sc_rt");
    const shapeFields = meta.hierarchy
      ? this.hierarchyFields(meta.root)
      : meta.def.fields.map((field) => ({ owner: meta, field }));
    const fields = shapeFields.map(({ owner, field }) => {
      const value = this.classFieldInitialValue(field.type, meta.def.loc);
      return `${this.classFieldStorageName(owner, field.name)}: ${value}`;
    }).join(", ");
    const emitter = this.isEmitterClass(meta.def.name) ? "sc_emitter: Some(runtime::emitter_new::<ScEmitterListener>()), " : "";
    const streamBase = this.runtimeStreamBase(meta.def.name);
    const readable = streamBase === "%Readable" ? "sc_readable: None, " : "";
    const writable = streamBase === "%Writable" ? "sc_writable: None, sc_writable_destroy: None, " : "";
    const duplex = streamBase === "%Duplex" ? "sc_duplex: None, " : "";
    const transform = streamBase === "%Transform" ? "sc_transform: None, " : "";
    const classTag = meta.hierarchy || this.isEmitterClass(meta.def.name) ? `sc_class_pre: ${meta.pre}, ` : "";
    return `{ let ${object} = runtime::Gc::new(${this.classStructName(meta.def.name, loc)} { ${classTag}${emitter}${readable}${writable}${duplex}${transform}${fields} }); ${mangleFunction(constructor.name)}(${[`${object}.clone()`, ...args].join(", ")}); ${object} }`;
  }

  private classFieldInitialValue(type: IrType, loc: SrcLoc): string {
    if (type.kind === "jsval") return `Some(${this.dynTypeName()}::Undefined)`;
    if (!this.context.isEdgeValue(type)) return this.context.defaultValue(type, loc);
    if (type.kind !== "union") return "None";
    const undefinedTag = this.union(type.unionId, loc).arms.findIndex((arm) => arm.kind === "undefinedT");
    return undefinedTag < 0
      ? "None"
      : `Some(${this.unionName(type.unionId)}::${this.unionVariant(undefinedTag)})`;
  }

  classFieldName(className: string, fieldName: string, loc?: SrcLoc): string {
    let owner = this.classMetaOf(className, loc);
    const index = owner.def.fields.findIndex((field) => field.name === fieldName);
    if (index < 0) this.context.unsupported(`unknown class field '${className}.${fieldName}'`, loc);
    while (owner.base !== null && index < owner.base.def.fields.length) owner = owner.base;
    return this.classFieldStorageName(owner, fieldName);
  }

  classFieldStorageName(owner: RustClassMeta, fieldName: string): string {
    return owner.hierarchy ? `sc_hf_${owner.pre}_${mangleField(fieldName)}` : mangleField(fieldName);
  }

  virtualImplementation(meta: RustClassMeta, slot: RustVtSlot): IrFunction {
    for (let current: RustClassMeta | null = meta; current !== null; current = current.base) {
      if (current.def.methods?.includes(slot.method) && !current.def.abstractMethods?.includes(slot.method)) {
        const fn = this.context.functions.get(`%${current.def.name}.${slot.method}`);
        if (fn === undefined) this.context.unsupported(`missing virtual implementation '${current.def.name}.${slot.method}'`, current.def.loc);
        return fn;
      }
    }
    this.context.unsupported(`missing virtual implementation '${meta.def.name}.${slot.method}'`, meta.def.loc);
  }

  closureName(shape: RustClosureShape): string {
    return `sc_closure_${shape.index}`;
  }

  dynTypeName(): string {
    return "sc_dyn_value";
  }

  dynFunctionVariant(shape: RustClosureShape): string {
    return `Function${shape.index}`;
  }

  dynFunctionCheckName(shape: RustClosureShape): string {
    return `sc_dyn_check_function_${shape.index}`;
  }

  promiseRejectorVariant(type: IrFuncType, promiseType: IrType, loc?: SrcLoc): string {
    const promiseTypes = this.context.promiseRejectorTypes.get(typeKey(type));
    const index = promiseTypes?.findIndex((candidate) => typeKey(candidate) === typeKey(promiseType)) ?? -1;
    if (index < 0) this.context.unsupported(`Promise rejector for '${typeKey(promiseType)}'`, loc);
    return `PromiseRejector${index}`;
  }

  closureVariant(target: IrFunction): string {
    const index = this.context.module().functions.indexOf(target);
    if (index < 0) this.context.unsupported(`unknown closure function '${target.name}'`, target.loc);
    return `ScFn${index}`;
  }

  captureField(index: number): string {
    return `sc_cap_${index}`;
  }

  union(id: string, loc?: SrcLoc): IrUnionDef {
    const union = this.context.unions.get(id);
    if (union === undefined) this.context.unsupported(`unknown union '${id}'`, loc);
    return union;
  }

  unionName(id: string): string {
    if (!/^[A-Za-z0-9_]+$/.test(id)) this.context.unsupported(`invalid union id '${id}'`);
    return `sc_u_${id}`;
  }

  unionVariant(tag: number): string {
    return `ScArm${tag}`;
  }

  unionEqName(id: string): string {
    return `sc_union_eq_${id}`;
  }

  rustString(value: string): string {
    let result = "";
    for (const char of value) {
      switch (char) {
        case "\\": result += "\\\\"; break;
        case "\"": result += "\\\""; break;
        case "\n": result += "\\n"; break;
        case "\r": result += "\\r"; break;
        case "\t": result += "\\t"; break;
        case "\0": result += "\\0"; break;
        default: {
          const code = char.codePointAt(0) ?? 0;
          result += code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : char;
        }
      }
    }
    return result;
  }

}
