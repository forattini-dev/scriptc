import type { IrClassDef, IrExpr, IrFunction, IrGlobal, IrRecordShape, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, RUNTIME_STREAM_CLASSES } from "../../ir/nodes.js";
import { mangleFunction, mangleGlobal, mangleLocal, mangleRecordStruct } from "../mangle.js";
import type { IrFuncType, RustClassMeta, RustClosureShape } from "./model.js";

export interface RustValueContext {
  readonly classes: ReadonlyMap<string, IrClassDef>;
  readonly globals: ReadonlyMap<string, IrGlobal>;
  readonly records: ReadonlyMap<string, IrRecordShape>;
  readonly unions: ReadonlyMap<string, IrUnionDef>;
  currentFunction(): IrFunction | null;
  isForcedBoxed(id: string): boolean;
  line(value: string): void;
  emitExpr(expr: IrExpr): string;
  classMetaOf(name: string, loc?: SrcLoc): RustClassMeta;
  classStructName(name: string, loc?: SrcLoc): string;
  closureName(shape: RustClosureShape): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  dynTypeName(): string;
  errorClassRoots(): RustClassMeta[];
  errorValueName(): string;
  rustString(value: string): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  emitContainerArrayIntrinsic(expr: Extract<IrExpr, { kind: "arrIntrinsic" }>): string;
  emitContainerArrayGetValues(expr: Extract<IrExpr, { kind: "arrayGet" }>, array: string, index: string): string;
  emitContainerBytesNewValue(expr: Extract<IrExpr, { kind: "bytesNew" }>, source: string | null): string;
  emitContainerArrayIntrinsicValues(expr: Extract<IrExpr, { kind: "arrIntrinsic" }>, receiver: string, args: readonly string[]): string;
  emitContainerMapIntrinsic(expr: Extract<IrExpr, { kind: "mapIntrinsic" }>): string;
  emitContainerMapIntrinsicValues(expr: Extract<IrExpr, { kind: "mapIntrinsic" }>, receiver: string, args: readonly string[]): string;
  emitContainerSetIntrinsic(expr: Extract<IrExpr, { kind: "setIntrinsic" }>): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export class RustValueEmitter {
  constructor(private readonly context: RustValueContext) {}

  emitOrDefault(expr: Extract<IrExpr, { kind: "orDefault" }>): string {
    if (expr.left.type.kind !== "union") {
      this.context.unsupported("orDefault over a non-union", expr.loc);
    }
    const union = this.context.union(expr.left.type.unionId, expr.loc);
    const left = "sc_or_default";
    const truthy = this.truthiness(left, expr.left.type, expr.loc);
    let present: string;
    if (expr.retag !== undefined) {
      present = `${mangleFunction(expr.retag)}(${left})`;
    } else {
      const nonUnitArms = union.arms.filter((arm) => !this.isUnit(arm));
      if (nonUnitArms.length !== 1) {
        this.context.unsupported("orDefault union without one value arm", expr.loc);
      }
      const name = this.context.unionName(union.id);
      const arms = union.arms.map((arm, tag) => {
        const variant = `${name}::${this.context.unionVariant(tag)}`;
        return this.isUnit(arm) ? `${variant} => unreachable!()` : `${variant}(value) => value`;
      }).join(", ");
      present = `match ${left} { ${arms} }`;
    }
    return `{ let ${left} = ${this.context.emitExpr(expr.left)}; if ${truthy} { ${present} } else { drop(${left}); ${this.context.emitExpr(expr.right)} } }`;
  }

  displayExpr(expr: IrExpr): string {
    return this.displayValue(this.context.emitExpr(expr), expr.type, expr.loc);
  }

  displayValue(value: string, type: IrType, loc: SrcLoc): string {
    switch (type.kind) {
      case "f64": return `runtime::display_number(${value})`;
      case "bool": return `runtime::display_bool(${value})`;
      case "string": return `runtime::display_string(&(${value}))`;
      default: this.context.unsupported(`console display type '${type.kind}'`, loc);
    }
  }

  truthiness(value: string, type: IrType, loc: SrcLoc): string {
    switch (type.kind) {
      case "bool": return value;
      case "f64": return `(${value} != 0.0 && !${value}.is_nan())`;
      case "string": return `!${value}.is_empty()`;
      case "array": return "true";
      case "date": return "true";
      case "bytes": return "true";
      case "map": return "true";
      case "set": return "true";
      case "stats": return "true";
      case "fileHandle": return "true";
      case "spawnRes": return "true";
      case "child": return "true";
      case "childStream": return "true";
      case "netServer": return "true";
      case "netSocket": return "true";
      case "httpReq": return "true";
      case "httpRes": return "true";
      case "httpClientReq": return "true";
      case "record": return "true";
      case "object": return "true";
      case "func": return "true";
      case "promise": return "true";
      case "generator": return "true";
      case "regex": return "true";
      case "symbol": return "true";
      case "url": return "true";
      case "searchParams": return "true";
      case "classval": return "true";
      case "union": {
        const union = this.context.union(type.unionId, loc);
        const name = this.context.unionName(union.id);
        const arms = union.arms.map((arm, tag) => {
          const variant = `${name}::${this.context.unionVariant(tag)}`;
          if (this.isUnit(arm)) return `${variant} => false`;
          if (arm.kind === "bool") return `${variant}(inner) => *inner`;
          if (arm.kind === "f64") return `${variant}(inner) => *inner != 0.0 && !inner.is_nan()`;
          if (arm.kind === "string") return `${variant}(inner) => !inner.is_empty()`;
          if (arm.kind === "classval") return `${variant}(inner) => *inner != 0`;
          if (arm.kind === "union") this.context.unsupported("nested union truthiness", loc);
          return `${variant}(..) => true`;
        }).join(", ");
        return `match &${value} { ${arms} }`;
      }
      default: this.context.unsupported(`truthiness for '${type.kind}'`, loc);
    }
  }

  emitRead(id: string, type: IrType, loc: SrcLoc): string {
    const global = this.context.globals.get(id);
    if (global !== undefined) {
      const name = mangleGlobal(id);
      if (this.isHeapRoot(type) || type.kind === "regex" || type.kind === "symbol" || type.kind === "url" || type.kind === "searchParams" || type.kind === "generator") {
        return `${name}.with(|slot| slot.borrow().as_ref().expect("scriptc: uninitialized global").clone())`;
      }
      if (this.needsClone(type)) return `${name}.with(|slot| slot.borrow().clone())`;
      if (type.kind === "f64" || type.kind === "date" || type.kind === "bool" || type.kind === "classval") return `${name}.with(Cell::get)`;
      this.context.unsupported(`global read type '${type.kind}'`, loc);
    }
    const local = this.local(id, loc);
    if (this.localIsBoxed(local)) {
      return local.tdz
        ? `runtime::cell_get_tdz(&${mangleLocal(id)}, "${this.context.rustString(local.name)}")`
        : `runtime::cell_get(&${mangleLocal(id)})`;
    }
    return this.needsClone(local.type) ? `${mangleLocal(id)}.clone()` : mangleLocal(id);
  }

  emitAssignment(id: string, value: string, loc: SrcLoc): void {
    this.context.line(`${this.assignmentExpr(id, value, loc)}`);
  }

  assignmentExpr(id: string, value: string, loc: SrcLoc): string {
    const global = this.context.globals.get(id);
    if (global !== undefined) {
      const name = mangleGlobal(id);
      if (this.isHeapRoot(global.type) || global.type.kind === "regex" || global.type.kind === "symbol" || global.type.kind === "url" || global.type.kind === "searchParams" || global.type.kind === "generator") return `${name}.with(|slot| *slot.borrow_mut() = Some(${value}));`;
      if (this.needsClone(global.type)) return `${name}.with(|slot| *slot.borrow_mut() = ${value});`;
      if (global.type.kind === "f64" || global.type.kind === "date" || global.type.kind === "bool" || global.type.kind === "classval") return `${name}.with(|slot| slot.set(${value}));`;
      this.context.unsupported(`global assignment type '${global.type.kind}'`, loc);
    }
    const local = this.local(id, loc);
    if (this.localIsBoxed(local)) return `runtime::cell_set(&${mangleLocal(id)}, ${value});`;
    return `${mangleLocal(id)} = ${value};`;
  }

  local(id: string, loc: SrcLoc) {
    const local = this.context.currentFunction()?.locals.find((candidate) => candidate.id === id);
    if (local === undefined) this.context.unsupported(`unknown local '${id}'`, loc);
    return local;
  }

  localIsBoxed(local: IrFunction["locals"][number]): boolean {
    return this.context.isForcedBoxed(local.id)
      || local.boxed === true
      || this.context.currentFunction()?.async === true
      || this.context.currentFunction()?.generator !== undefined;
  }

  rustBytesElement(elem: "u8" | "u32" | "i32" | "f32"): string {
    return elem;
  }

  rustType(type: IrType, loc?: SrcLoc): string {
    switch (type.kind) {
      case "void": return "()";
      case "f64": return "f64";
      case "date": return "f64";
      case "bool": return "bool";
      case "string": return "runtime::JsString";
      case "classval": {
        this.context.classMetaOf(type.className, loc);
        return "usize";
      }
      case "array": return `runtime::JsArray<${this.rustType(type.elem, loc)}>`;
      case "bytes": return `runtime::JsBytes<${this.rustBytesElement(type.elem)}>`;
      case "stats": return "runtime::JsStats";
      case "fileHandle": return "runtime::JsFileHandle";
      case "spawnRes": return "runtime::JsSpawnResult";
      case "child": return "runtime::JsChild";
      case "childStream": return "runtime::JsChildStream";
      case "netServer": return "runtime::JsNetServer";
      case "netSocket": return "runtime::JsNetSocket";
      case "httpReq": return "runtime::JsHttpRequest";
      case "httpRes": return "runtime::JsHttpResponse";
      case "httpClientReq": return "runtime::JsHttpClientRequest";
      case "map": return `runtime::JsMap<${this.rustType(type.key, loc)}, ${this.rustType(type.value, loc)}>`;
      case "set": return `runtime::JsSet<${this.rustType(type.elem, loc)}>`;
      case "record": {
        const shape = this.context.records.get(type.shapeId);
        if (shape === undefined) this.context.unsupported(`unknown record type '${type.shapeId}'`, loc);
        if (shape.indexValue !== undefined && shape.fields.length === 0) {
          const value = shape.indexValue.kind === "dyn"
            ? this.context.dynTypeName()
            : this.rustType(shape.indexValue, loc);
          return `runtime::JsMap<runtime::JsString, ${value}>`;
        }
        return `runtime::Gc<${mangleRecordStruct(type.shapeId)}>`;
      }
      case "object": {
        if (RUNTIME_ERROR_CLASSES.has(type.className)) {
          return this.context.errorClassRoots().length === 0 ? "runtime::JsError" : this.context.errorValueName();
        }
        if (type.className === RUNTIME_EMITTER_CLASS) return "ScEventEmitter";
        if (type.className === "%Readable") return "ScReadable";
        if (type.className === "%Writable") return "ScWritable";
        if (type.className === "%Duplex") return "ScDuplex";
        if (type.className === "%Transform") return "ScTransform";
        if (type.className === "%PassThrough") return "ScTransform";
        if (!this.context.classes.has(type.className)) this.context.unsupported(`object type '${type.className}'`, loc);
        return `runtime::Gc<${this.context.classStructName(type.className, loc)}>`;
      }
      case "union": {
        if (!this.context.unions.has(type.unionId)) this.context.unsupported(`unknown union type '${type.unionId}'`, loc);
        return this.context.unionName(type.unionId);
      }
      case "func": {
        const shape = this.context.closureShapeForType(type, loc);
        return `runtime::Gc<${this.context.closureName(shape)}>`;
      }
      case "promise": return `runtime::JsPromise<${this.rustType(type.inner, loc)}>`;
      case "generator": {
        const channel = (value: IrType): string =>
          value.kind === "undefinedT" || value.kind === "nullT" ? "()" : this.rustType(value, loc);
        return `runtime::JsGenerator<${channel(type.yieldT)}, ${channel(type.retT)}, ${channel(type.nextT)}>`;
      }
      case "regex": return "runtime::JsRegex";
      case "symbol": return "runtime::JsSymbol";
      case "url": return "runtime::JsUrl";
      case "searchParams": return "runtime::JsSearchParams";
      case "caught": return "runtime::Caught";
      case "dyn": return this.context.dynTypeName();
      default: this.context.unsupported(`type '${type.kind}'`, loc);
    }
  }

  defaultValue(type: IrType, loc: SrcLoc): string {
    switch (type.kind) {
      case "f64": return "0.0";
      case "date": return "0.0";
      case "bool": return "false";
      case "string": return "runtime::empty_string()";
      case "symbol": return "runtime::symbol_new_anonymous()";
      case "array": return "runtime::array_new(Vec::new())";
      case "bytes": return `runtime::bytes_empty::<${this.rustBytesElement(type.elem)}>()`;
      case "map": return "runtime::map_new()";
      case "set": return "runtime::set_new()";
      case "classval": return "0";
      case "union": {
        const union = this.context.union(type.unionId, loc);
        const tag = union.arms.findIndex((arm) => arm.kind === "undefinedT" || arm.kind === "nullT");
        if (tag >= 0) return `${this.context.unionName(union.id)}::${this.context.unionVariant(tag)}`;
        this.context.unsupported("uninitialized union without an empty arm", loc);
      }
      default: this.context.unsupported(`uninitialized '${type.kind}' local`, loc);
    }
  }

  numberLiteral(value: number): string {
    if (Number.isNaN(value)) return "f64::NAN";
    if (value === Infinity) return "f64::INFINITY";
    if (value === -Infinity) return "f64::NEG_INFINITY";
    if (Object.is(value, -0)) return "-0.0_f64";
    const spelling = String(value).replace("e+", "e");
    return Number.isInteger(value) && !spelling.includes("e")
      ? `${spelling}.0_f64`
      : `${spelling}_f64`;
  }

  emitArrayIntrinsic(expr: Extract<IrExpr, { kind: "arrIntrinsic" }>): string {
    return this.context.emitContainerArrayIntrinsic(expr);
  }

  emitArrayGetValues(
    expr: Extract<IrExpr, { kind: "arrayGet" }>,
    array: string,
    index: string,
  ): string {
    return this.context.emitContainerArrayGetValues(expr, array, index);
  }

  emitBytesNewValue(
    expr: Extract<IrExpr, { kind: "bytesNew" }>,
    source: string | null,
  ): string {
    return this.context.emitContainerBytesNewValue(expr, source);
  }

  emitArrayIntrinsicValues(
    expr: Extract<IrExpr, { kind: "arrIntrinsic" }>,
    receiver: string,
    args: readonly string[],
  ): string {
    return this.context.emitContainerArrayIntrinsicValues(expr, receiver, args);
  }

  emitMapIntrinsic(expr: Extract<IrExpr, { kind: "mapIntrinsic" }>): string {
    return this.context.emitContainerMapIntrinsic(expr);
  }

  emitMapIntrinsicValues(
    expr: Extract<IrExpr, { kind: "mapIntrinsic" }>,
    receiver: string,
    args: readonly string[],
  ): string {
    return this.context.emitContainerMapIntrinsicValues(expr, receiver, args);
  }

  emitSetIntrinsic(expr: Extract<IrExpr, { kind: "setIntrinsic" }>): string {
    return this.context.emitContainerSetIntrinsic(expr);
  }

  needsClone(type: IrType): boolean {
    return type.kind === "string" || type.kind === "regex" || type.kind === "symbol" || type.kind === "url" || type.kind === "searchParams" || type.kind === "generator" || type.kind === "union" || type.kind === "caught" || type.kind === "dyn" ||
      (type.kind === "object" && (RUNTIME_ERROR_CLASSES.has(type.className) || type.className === RUNTIME_EMITTER_CLASS)) || this.isTracedHandle(type);
  }

  arrayElementEquality(left: string, right: string, type: IrType, sameValueZero: boolean, loc: SrcLoc): string {
    switch (type.kind) {
      case "f64":
        return sameValueZero
          ? `(*${left} == *${right} || (${left}.is_nan() && ${right}.is_nan()))`
          : `*${left} == *${right}`;
      case "bool":
      case "classval":
        return `${left} == ${right}`;
      case "string":
        return `${left}.as_ref() == ${right}.as_ref()`;
      case "symbol":
        return `runtime::symbol_ptr_eq(${left}, ${right})`;
      case "func":
        return `${this.functionIdentity(left, type, loc)} == ${this.functionIdentity(right, type, loc)}`;
      case "array":
      case "record":
        return `${left}.ptr_eq(${right})`;
      case "object":
        if (type.className === RUNTIME_EMITTER_CLASS) return `${left} == ${right}`;
        if (type.className === "%Readable") return `runtime::readable_ptr_eq(${left}, ${right})`;
        if (type.className === "%Writable") return `runtime::writable_ptr_eq(${left}, ${right})`;
        if (type.className === "%Duplex") return `runtime::duplex_ptr_eq(${left}, ${right})`;
        if (type.className === "%Transform") return `runtime::transform_ptr_eq(${left}, ${right})`;
        if (type.className === "%PassThrough") return `runtime::transform_ptr_eq(${left}, ${right})`;
        if (this.context.classes.has(type.className)) return `${left}.ptr_eq(${right})`;
        this.context.unsupported(`array identity for runtime object '${type.className}'`, loc);
      default:
        this.context.unsupported(`array ${sameValueZero ? "includes" : "indexOf"} element '${type.kind}'`, loc);
    }
  }

  mapKeyEquality(left: string, right: string, type: IrType, loc: SrcLoc): string {
    if (type.kind === "f64") return `(*${left} == *${right} || (${left}.is_nan() && ${right}.is_nan()))`;
    if (type.kind === "string") return `${left}.as_ref() == ${right}.as_ref()`;
    if (type.kind === "symbol") return `runtime::symbol_ptr_eq(${left}, ${right})`;
    if (type.kind === "netServer" || type.kind === "netSocket" || type.kind === "httpReq" ||
        type.kind === "httpRes" || type.kind === "httpClientReq") {
      return `${left}.ptr_eq(${right})`;
    }
    this.context.unsupported(`map key '${type.kind}'`, loc);
  }

  private functionIdentity(value: string, type: IrFuncType, loc: SrcLoc): string {
    const shape = this.context.closureShapeForType(type, loc);
    return `sc_closure_identity_${shape.index}(${value})`;
  }

  mapStoredKey(value: string, type: IrType): string {
    return type.kind === "f64" ? `if ${value} == 0.0 { 0.0 } else { ${value} }` : value;
  }

  isTracedHandle(type: IrType): boolean {
    return type.kind === "array" || type.kind === "bytes" || type.kind === "map" || type.kind === "set" || type.kind === "stats" || type.kind === "fileHandle" || type.kind === "spawnRes" || type.kind === "child" || type.kind === "childStream" || type.kind === "netServer" || type.kind === "netSocket" || type.kind === "httpReq" || type.kind === "httpRes" || type.kind === "httpClientReq" || type.kind === "record" || type.kind === "promise" ||
      (type.kind === "object" && (this.context.classes.has(type.className) || RUNTIME_STREAM_CLASSES.has(type.className) ||
        (RUNTIME_ERROR_CLASSES.has(type.className) && this.context.errorClassRoots().length > 0))) || type.kind === "func";
  }

  isEdgeValue(type: IrType): boolean {
    return this.isTracedHandle(type) || type.kind === "union" || type.kind === "dyn" ||
      (type.kind === "object" && type.className === RUNTIME_EMITTER_CLASS);
  }

  isHeapRoot(type: IrType): boolean {
    return this.isEdgeValue(type) || (type.kind === "object" && RUNTIME_ERROR_CLASSES.has(type.className));
  }

  isUnit(type: IrType): boolean {
    return type.kind === "undefinedT" || type.kind === "nullT";
  }

  isRustJsonCompatible(type: IrType, visiting = new Set<string>()): boolean {
    switch (type.kind) {
      case "f64":
      case "bool":
      case "string":
      case "undefinedT":
      case "nullT":
        return true;
      case "array":
        return this.isRustJsonCompatible(type.elem, visiting);
      case "record": {
        const key = `record:${type.shapeId}`;
        if (visiting.has(key)) return true;
        const shape = this.context.records.get(type.shapeId);
        if (shape === undefined) return false;
        const next = new Set(visiting).add(key);
        return shape.fields.every((field) => this.isRustJsonCompatible(field.type, next)) &&
          (shape.indexValue === undefined || this.isRustJsonCompatible(shape.indexValue, next));
      }
      case "union": {
        const key = `union:${type.unionId}`;
        if (visiting.has(key)) return true;
        const union = this.context.unions.get(type.unionId);
        if (union === undefined) return false;
        const next = new Set(visiting).add(key);
        return union.arms.every((arm) => this.isRustJsonCompatible(arm, next));
      }
      default:
        return false;
    }
  }

  ensureUnionArm(type: IrType): void {
    switch (type.kind) {
      case "f64":
      case "bool":
      case "string":
      case "array":
      case "bytes":
      case "record":
      case "object":
      case "classval":
      case "func":
      case "promise":
      case "child":
      case "childStream":
      case "netServer":
      case "netSocket":
      case "httpReq":
      case "httpRes":
      case "httpClientReq":
      case "regex":
      case "symbol":
      case "url":
      case "searchParams":
      case "undefinedT":
      case "nullT":
        return;
      default:
        this.context.unsupported(`union arm '${type.kind}'`);
    }
  }

}
