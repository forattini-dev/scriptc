import type { IrType, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_ERROR_CLASSES, typeKey } from "../../ir/nodes.js";
import { mangleField } from "../mangle.js";
import type { RustDynamicContext } from "./dynamic.js";
import { RUST_RECORD_OVERFLOW } from "./record-layout.js";

interface DynFromHelper {
  readonly name: string;
  readonly type: IrType;
  readonly loc: SrcLoc | undefined;
  readonly liveRef: boolean;
}

/** Emits typed-to-dynamic deep copies.
 *
 * Acyclic shapes stay inline. Recursive composites are interned as named
 * helpers so records, arrays, and unions can call one another without the
 * TypeScript emitter recursively expanding the type graph forever.
 */
export class RustDynamicFromEmitter {
  private readonly helperNames = new Map<string, string>();
  private readonly helpers: DynFromHelper[] = [];

  constructor(private readonly context: RustDynamicContext) {}

  emit(type: IrType, value: string, loc?: SrcLoc, functionName = "", liveRef = false): string {
    if (this.isRecursiveComposite(type)) {
      return `${this.internHelper(type, loc, liveRef)}(${value})`;
    }
    return this.emitInline(type, value, loc, functionName, liveRef);
  }

  emitDefinitions(): void {
    for (let index = 0; index < this.helpers.length; index++) {
      const helper = this.helpers[index];
      if (helper === undefined) continue;
      this.context.line(`fn ${helper.name}(value: ${this.context.rustType(helper.type, helper.loc)}) -> ${this.context.dynTypeName()} {`);
      this.context.pushIndent();
      this.context.line(this.emitInline(helper.type, "value", helper.loc, "", helper.liveRef));
      this.context.popIndent();
      this.context.line("}");
      this.context.line("");
    }
  }

  private internHelper(type: IrType, loc: SrcLoc | undefined, liveRef: boolean): string {
    const key = `${liveRef ? "live" : "copy"}:${typeKey(type)}`;
    const existing = this.helperNames.get(key);
    if (existing !== undefined) return existing;
    const name = `sc_dyn_from_${this.helpers.length}`;
    this.helperNames.set(key, name);
    this.helpers.push({ name, type, loc, liveRef });
    return name;
  }

  private emitInline(type: IrType, value: string, loc?: SrcLoc, functionName = "", liveRef = false): string {
    const name = this.context.dynTypeName();
    switch (type.kind) {
      case "dyn": return value;
      case "f64": return `${name}::Number(${value})`;
      case "bool": return `${name}::Boolean(${value})`;
      case "string": return `${name}::String(${value})`;
      case "bytes": {
        if (type.elem !== "u8") this.context.unsupported(`dynamic boxing from bytes<${type.elem}>`, loc);
        return liveRef ? `{ let source = ${value}; let mirror = runtime::bytes_copy(&source); runtime::live_dyn_ref_store(mirror.identity(), source); ${name}::Bytes(mirror) }` : `${name}::Bytes(runtime::bytes_copy(&(${value})))`;
      }
      case "promise": return `${name}::Promise(runtime::promise_to_handle(&(${value})))`;
      case "netServer": return `${name}::NetServer(${value})`;
      case "netSocket": return `${name}::NetSocket(${value})`;
      case "httpReq": return `${name}::HttpRequest(${value})`;
      case "httpRes": return `${name}::HttpResponse(${value})`;
      case "undefinedT": return `{ let _ = ${value}; ${name}::Undefined }`;
      case "nullT": return `{ let _ = ${value}; ${name}::Null }`;
      case "func": {
        const shape = this.context.closureShapeForType(type, loc);
        if (!this.context.dynBoxedFunctionShapes.has(typeKey(type))) {
          this.context.unsupported(`dynamic function boxing for '${typeKey(type)}'`, loc);
        }
        if (this.context.usesDynamicInvoke()) {
          return `sc_dyn_box_function_${shape.index}(${value}, runtime::string("${this.context.rustString(functionName)}"))`;
        }
        return `${name}::${this.context.dynFunctionVariant(shape)}(${value}, runtime::string("${this.context.rustString(functionName)}"), runtime::map_new())`;
      }
      case "array": {
        const source = this.context.nextTemporary();
        const output = this.context.nextTemporary();
        const index = this.context.nextTemporary();
        const element = this.emit(type.elem, `runtime::array_get(&${source}, ${index})`, loc, "", liveRef);
        const guard = this.isRecursiveComposite(type)
          ? `let _sc_dyn_guard = runtime::dyn_from_enter(${source}.identity()); `
          : "";
        return `{ let ${source} = ${value}; ${guard}let ${output}: runtime::JsArray<${name}> = runtime::array_new(Vec::new()); let mut ${index} = 0.0; while ${index} < runtime::array_len(&${source}) { runtime::array_push(&${output}, ${element}); ${index} += 1.0; } ${liveRef ? `runtime::live_dyn_ref_store(${output}.identity(), ${source}); ` : ""}${name}::Array(${output}) }`;
      }
      case "union": {
        const union = this.context.union(type.unionId, loc);
        const unionValue = this.context.nextTemporary();
        const arms = union.arms.map((arm, tag) => {
          const variant = `${this.context.unionName(union.id)}::${this.context.unionVariant(tag)}`;
          if (this.context.isUnit(arm)) return `${variant} => ${this.emit(arm, "()", loc, "", liveRef)}`;
          return `${variant}(payload) => ${this.emit(arm, "payload", loc, "", liveRef)}`;
        }).join(", ");
        return `{ let ${unionValue} = ${value}; match ${unionValue} { ${arms} } }`;
      }
      case "object": {
        if (!RUNTIME_ERROR_CLASSES.has(type.className)) {
          this.context.unsupported(`dynamic boxing from object '${type.className}'`, loc);
        }
        if (this.context.errorClassRoots().length > 0) {
          this.context.unsupported("dynamic Error boxing alongside user Error subclasses", loc);
        }
        const error = this.context.nextTemporary();
        return `{ let ${error} = ${value}; sc_dyn_error_box(&${error}) }`;
      }
      case "record": return this.emitRecord(type, value, loc, liveRef);
      default:
        this.context.unsupported(`dynamic boxing from '${type.kind}'`, loc);
    }
  }

  private emitRecord(type: Extract<IrType, { kind: "record" }>, value: string, loc?: SrcLoc, liveRef = false): string {
    const name = this.context.dynTypeName();
    const shape = this.context.records.get(type.shapeId);
    if (shape?.tuple) {
      const record = this.context.nextTemporary();
      const output = this.context.nextTemporary();
      const fields = [...shape.fields]
        .sort((left, right) => Number(left.name) - Number(right.name))
        .map((field) => {
          const stored = `${record}.${mangleField(field.name)}`;
          const fieldValue = this.context.isEdgeValue(field.type)
            ? `${stored}.as_ref().expect("scriptc: cleared live dynamic tuple field").clone()`
            : this.context.needsClone(field.type) ? `${stored}.clone()` : stored;
          return `runtime::array_push(&${output}, ${this.emit(field.type, fieldValue, loc, "", liveRef)});`;
        }).join(" ");
      const guard = this.isRecursiveComposite(type)
        ? `let _sc_dyn_guard = runtime::dyn_from_enter(${record}.identity()); `
        : "";
      return `{ let ${record} = ${value}; ${guard}let ${output}: runtime::JsArray<${name}> = runtime::array_new(Vec::new()); ${record}.with(|${record}| { ${fields} }); ${liveRef ? `runtime::live_dyn_ref_store(${output}.identity(), ${record}); ` : ""}${name}::Array(${output}) }`;
    }
    if (shape?.indexValue?.kind === "dyn" && shape.fields.length === 0) {
      return liveRef ? `{ let source = ${value}; let mirror = match sc_dyn_deep_copy(&${name}::Object(source.clone())) { ${name}::Object(value) => value, _ => unreachable!() }; runtime::live_dyn_ref_store(mirror.identity(), source); ${name}::Object(mirror) }` : `sc_dyn_deep_copy(&${name}::Object(${value}))`;
    }
    if (shape?.indexValue !== undefined && shape.fields.length === 0) {
      const source = this.context.nextTemporary();
      const output = this.context.nextTemporary();
      const index = this.context.nextTemporary();
      const field = this.emit(shape.indexValue, `runtime::map_iter_value(&${source}, ${index})`, loc, "", liveRef);
      const guard = this.isRecursiveComposite(type)
        ? `let _sc_dyn_guard = runtime::dyn_from_enter(${source}.identity()); `
        : "";
      return `{ let ${source} = ${value}; ${guard}let ${output}: runtime::JsMap<runtime::JsString, ${name}> = runtime::map_new(); let mut ${index} = 0.0; while ${index} < runtime::map_iter_count(&${source}) { if runtime::map_iter_live(&${source}, ${index}) { let key = runtime::map_iter_key(&${source}, ${index}); runtime::map_set_by(&${output}, key, ${field}, |left, right| left.as_ref() == right.as_ref()); } ${index} += 1.0; } ${liveRef ? `runtime::live_dyn_ref_store(${output}.identity(), ${source}); ` : ""}${name}::Object(${output}) }`;
    }
    if (shape === undefined) this.context.unsupported(`dynamic boxing from record '${type.shapeId}'`, loc);
    const record = this.context.nextTemporary();
    const object = this.context.nextTemporary();
    const byName = new Map(shape.fields.map((field) => [field.name, field]));
    const fields = (shape.declaredOrder ?? shape.fields.map((field) => field.name)).map((fieldName) => {
      const field = byName.get(fieldName);
      if (field === undefined) this.context.unsupported(`missing declared record field '${type.shapeId}.${fieldName}'`, loc);
      const stored = `${record}.${mangleField(field.name)}`;
      const fieldValue = this.context.isEdgeValue(field.type)
        ? `${stored}.as_ref().expect("scriptc: cleared live dynamic record field").clone()`
        : this.context.needsClone(field.type) ? `${stored}.clone()` : stored;
      const dynamic = this.emit(field.type, fieldValue, loc, "", liveRef);
      return `runtime::map_set_by(&${object}, runtime::string("${this.context.rustString(field.name)}"), ${dynamic}, |left, right| left.as_ref() == right.as_ref());`;
    }).join(" ");
    const overflow = shape.indexValue === undefined ? "" : (() => {
      const source = this.context.nextTemporary();
      const index = this.context.nextTemporary();
      const dynamic = shape.indexValue.kind === "dyn"
        ? `runtime::map_iter_value(&${source}, ${index})`
        : this.emit(shape.indexValue, `runtime::map_iter_value(&${source}, ${index})`, loc, "", liveRef);
      return `let ${source} = ${record}.${RUST_RECORD_OVERFLOW}.as_ref().expect("scriptc: cleared live record overflow").clone(); let mut ${index} = 0.0; while ${index} < runtime::map_iter_count(&${source}) { if runtime::map_iter_live(&${source}, ${index}) { let sc_key = runtime::map_iter_key(&${source}, ${index}); runtime::map_set_by(&${object}, sc_key, ${dynamic}, |left, right| left.as_ref() == right.as_ref()); } ${index} += 1.0; }`;
    })();
    const guard = this.isRecursiveComposite(type)
      ? `let _sc_dyn_guard = runtime::dyn_from_enter(${record}.identity()); `
      : "";
    return `{ let ${record} = ${value}; ${guard}let ${object}: runtime::JsMap<runtime::JsString, ${name}> = runtime::map_new(); ${record}.with(|${record}| { ${fields} ${overflow} }); ${liveRef ? `runtime::live_dyn_ref_store(${object}.identity(), ${record}); ` : ""}${name}::Object(${object}) }`;
  }

  private isRecursiveComposite(type: IrType): boolean {
    return this.reachesActiveType(type, new Set());
  }

  private reachesActiveType(type: IrType, active: Set<string>): boolean {
    if (type.kind === "array") return this.reachesActiveType(type.elem, active);
    if (type.kind === "record") {
      const key = `record:${type.shapeId}`;
      if (active.has(key)) return true;
      const shape = this.context.records.get(type.shapeId);
      if (shape === undefined) return false;
      active.add(key);
      const recursive = shape.fields.some((field) => this.reachesActiveType(field.type, active)) ||
        (shape.indexValue !== undefined && this.reachesActiveType(shape.indexValue, active));
      active.delete(key);
      return recursive;
    }
    if (type.kind === "union") {
      const key = `union:${type.unionId}`;
      if (active.has(key)) return true;
      const union = this.context.unions.get(type.unionId);
      if (union === undefined) return false;
      active.add(key);
      const recursive = union.arms.some((arm) => this.reachesActiveType(arm, active));
      active.delete(key);
      return recursive;
    }
    return false;
  }
}
