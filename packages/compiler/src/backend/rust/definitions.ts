import type { IrExpr, IrFunction, IrGlobal, IrRecordShape, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, typeKey } from "../../ir/nodes.js";
import {
  mangleClassStruct,
  mangleField,
  mangleFnClosure,
  mangleFunction,
  mangleGlobal,
  mangleLocal,
  mangleRawParam,
  mangleRecordStruct,
} from "../mangle.js";
import { emitRustGeneratorBody } from "./generators.js";
import type { RustClassMeta, RustClosureShape } from "./model.js";
import { RUST_RECORD_OVERFLOW } from "./record-layout.js";

export interface RustDefinitionContext {
  readonly classMeta: ReadonlyMap<string, RustClassMeta>;
  readonly closureShapes: ReadonlyMap<string, RustClosureShape>;
  readonly closureTargets: ReadonlyMap<string, RustClosureShape>;
  readonly dynAdapterShapes: ReadonlySet<string>;
  readonly emitterSnapshotShapes: ReadonlyMap<string, RustClosureShape>;
  readonly globals: ReadonlyMap<string, IrGlobal>;
  readonly internedClosureTargets: ReadonlySet<string>;
  readonly promiseRejectorTypes: ReadonlyMap<string, IrType[]>;
  readonly promiseResolverTypes: ReadonlyMap<string, IrType>;
  readonly records: ReadonlyMap<string, IrRecordShape>;
  readonly unions: ReadonlyMap<string, IrUnionDef>;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextName(prefix: string): string;
  setCurrentFunction(fn: IrFunction | null): void;
  setCurrentAsyncResult(result: string | null): void;
  setCurrentAsyncLocals(locals: Set<string> | null): void;
  emitDynamicDefinition(): void;
  emitDynFromValue(type: IrType, value: string, loc?: SrcLoc, functionName?: string, liveRef?: boolean): string;
  emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc): string;
  emitAsyncStatements(statements: readonly IrStmt[], onComplete?: (() => void) | null): void;
  assignmentExpr(id: string, value: string, loc: SrcLoc): string;
  emitExpr(expr: IrExpr): string;
  emitExprWithValues(expr: IrExpr, values: readonly (readonly [IrExpr, string])[]): string;
  emitStatements(statements: readonly IrStmt[]): void;
  captureField(index: number): string;
  classFieldName(className: string, fieldName: string, loc?: SrcLoc): string;
  classFieldStorageName(owner: RustClassMeta, fieldName: string): string;
  classStructName(name: string, loc?: SrcLoc): string;
  closureName(shape: RustClosureShape): string;
  closureVariant(target: IrFunction): string;
  dynTypeName(): string;
  ensureUnionArm(type: IrType): void;
  errorClassRoots(): RustClassMeta[];
  errorValueName(): string;
  errorValueVariant(meta: RustClassMeta): string;
  hierarchyFields(root: RustClassMeta): { owner: RustClassMeta; field: RustClassMeta["def"]["fields"][number] }[];
  isEdgeValue(type: IrType): boolean;
  isEmitterClass(name: string): boolean;
  isRustJsonCompatible(type: IrType, visiting?: Set<string>): boolean;
  isTracedHandle(type: IrType): boolean;
  isUnit(type: IrType): boolean;
  runtimeErrorClassNames(name: string): string[];
  rustString(value: string): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionEqName(id: string): string;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export class RustDefinitionEmitter {
  constructor(private readonly context: RustDefinitionContext) {}

  emitClosureDefinitions(): void {
    for (const shape of this.context.closureShapes.values()) {
      const name = this.context.closureName(shape);
      const dynAdapter = this.context.dynAdapterShapes.has(typeKey(shape.type));
      const eventAdapter = this.context.emitterSnapshotShapes.has(typeKey(shape.type));
      const resolverType = this.context.promiseResolverTypes.get(typeKey(shape.type));
      const rejectorTypes = this.context.promiseRejectorTypes.get(typeKey(shape.type)) ?? [];
      const runtimeCallback = shape.runtimeCallback === true;
      this.context.line(`enum ${name} {`);
      this.context.pushIndent();
      for (const target of shape.targets) {
        const captures = target.captures ?? [];
        if (captures.length === 0) {
          this.context.line(`${this.context.closureVariant(target)},`);
        } else {
          const fields = captures.map((capture, index) =>
            `${this.context.captureField(index)}: Option<runtime::JsCell<${this.context.rustType(capture.type, target.loc)}>>`,
          ).join(", ");
          this.context.line(`${this.context.closureVariant(target)} { ${fields} },`);
        }
      }
      if (resolverType !== undefined) {
        this.context.line(`PromiseResolver { promise: Option<runtime::JsPromise<${this.context.rustType(resolverType)}>> },`);
      }
      rejectorTypes.forEach((promiseType, index) => {
        this.context.line(`PromiseRejector${index} { promise: Option<runtime::JsPromise<${this.context.rustType(promiseType)}>> },`);
      });
      if (dynAdapter) this.context.line(`DynAdapter { value: Option<${this.context.dynTypeName()}> },`);
      if (eventAdapter) this.context.line("EventAdapter { listener: Option<ScEmitterListener>, identity: usize },");
      if (runtimeCallback) {
        const params = shape.type.params.map((type) => this.context.rustType(type)).join(", ");
        this.context.line(`RuntimeCallback { callback: Option<std::rc::Rc<dyn Fn(${params}) -> ${this.context.rustType(shape.type.ret)}>>, trace: Option<std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>> },`);
      }
      this.context.popIndent();
      this.context.line("}");
      this.context.line(`impl runtime::Trace for ${name} {`);
      this.context.pushIndent();
      this.context.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.context.pushIndent();
      const capturing = shape.targets.filter((target) => (target.captures?.length ?? 0) > 0);
      if (capturing.length === 0 && resolverType === undefined && rejectorTypes.length === 0 && !dynAdapter && !eventAdapter && !runtimeCallback) {
        this.context.line("let _ = tracer;");
      } else {
        this.context.line("match self {");
        this.context.pushIndent();
        for (const target of capturing) {
          const fields = (target.captures ?? []).map((_, index) => this.context.captureField(index));
          this.context.line(`Self::${this.context.closureVariant(target)} { ${fields.join(", ")} } => {`);
          this.context.pushIndent();
          for (const field of fields) {
            this.context.line(`if let Some(edge) = ${field} { tracer.edge(edge); }`);
          }
          this.context.popIndent();
          this.context.line("},");
        }
        if (resolverType !== undefined) {
          this.context.line("Self::PromiseResolver { promise } => {");
          this.context.pushIndent();
          this.context.line("if let Some(edge) = promise { tracer.edge(edge); }");
          this.context.popIndent();
          this.context.line("},");
        }
        rejectorTypes.forEach((_, index) => {
          this.context.line(`Self::PromiseRejector${index} { promise } => {`);
          this.context.pushIndent();
          this.context.line("if let Some(edge) = promise { tracer.edge(edge); }");
          this.context.popIndent();
          this.context.line("},");
        });
        if (dynAdapter) {
          this.context.line("Self::DynAdapter { value } => {");
          this.context.pushIndent();
          this.context.line("if let Some(edge) = value { runtime::Trace::trace(edge, tracer); }");
          this.context.popIndent();
          this.context.line("},");
        }
        if (eventAdapter) {
          this.context.line("Self::EventAdapter { listener, .. } => {");
          this.context.pushIndent();
          this.context.line("if let Some(edge) = listener { runtime::Trace::trace(edge, tracer); }");
          this.context.popIndent();
          this.context.line("},");
        }
        if (runtimeCallback) {
          this.context.line("Self::RuntimeCallback { trace, .. } => {");
          this.context.pushIndent();
          this.context.line("if let Some(trace) = trace { trace(tracer); }");
          this.context.popIndent();
          this.context.line("},");
        }
        this.context.line("_ => {},");
        this.context.popIndent();
        this.context.line("}");
      }
      this.context.popIndent();
      this.context.line("}");
      this.context.popIndent();
      this.context.line("}");
      this.context.line(`impl runtime::ClearEdges for ${name} {`);
      this.context.pushIndent();
      this.context.line("fn clear_edges(&mut self) {");
      this.context.pushIndent();
      if (capturing.length > 0 || resolverType !== undefined || rejectorTypes.length > 0 || dynAdapter || eventAdapter || runtimeCallback) {
        this.context.line("match self {");
        this.context.pushIndent();
        for (const target of capturing) {
          const fields = (target.captures ?? []).map((_, index) => this.context.captureField(index));
          this.context.line(`Self::${this.context.closureVariant(target)} { ${fields.join(", ")} } => {`);
          this.context.pushIndent();
          for (const field of fields) this.context.line(`*${field} = None;`);
          this.context.popIndent();
          this.context.line("},");
        }
        if (resolverType !== undefined) {
          this.context.line("Self::PromiseResolver { promise } => *promise = None,");
        }
        rejectorTypes.forEach((_, index) => {
          this.context.line(`Self::PromiseRejector${index} { promise } => *promise = None,`);
        });
        if (dynAdapter) this.context.line("Self::DynAdapter { value } => *value = None,");
        if (eventAdapter) this.context.line("Self::EventAdapter { listener, .. } => *listener = None,");
        if (runtimeCallback) this.context.line("Self::RuntimeCallback { callback, trace } => { *callback = None; *trace = None; },");
        this.context.line("_ => {},");
        this.context.popIndent();
        this.context.line("}");
      }
      this.context.popIndent();
      this.context.line("}");
      this.context.popIndent();
      this.context.line("}");
      this.context.line(`fn sc_closure_identity_${shape.index}(value: &runtime::Gc<${name}>) -> usize {`);
      this.context.pushIndent();
      this.context.line(eventAdapter
        ? `value.with(|closure| match closure { ${name}::EventAdapter { identity, .. } => *identity, _ => value.identity(), })`
        : "value.identity()");
      this.context.popIndent();
      this.context.line("}");
      this.context.line("");
    }
  }

  emitDynamicDefinition(): void {
    this.context.emitDynamicDefinition();
  }

  emitDynFromValue(type: IrType, value: string, loc?: SrcLoc, functionName = "", liveRef = false): string {
    return this.context.emitDynFromValue(type, value, loc, functionName, liveRef);
  }

  emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc): string {
    return this.context.emitDynCheckValue(type, value, loc);
  }

  emitUnionDefinitions(): void {
    for (const union of this.context.unions.values()) {
      const name = this.context.unionName(union.id);
      this.context.line("#[derive(Clone)]");
      this.context.line(`enum ${name} {`);
      this.context.pushIndent();
      union.arms.forEach((arm, tag) => {
        this.context.ensureUnionArm(arm);
        this.context.line(this.context.isUnit(arm)
          ? `${this.context.unionVariant(tag)},`
          : `${this.context.unionVariant(tag)}(${this.context.rustType(arm)}),`);
      });
      this.context.popIndent();
      this.context.line("}");
      this.context.line(`impl runtime::Trace for ${name} {`);
      this.context.pushIndent();
      this.context.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.context.pushIndent();
      const traced = union.arms
        .map((arm, tag) => ({ arm, tag }))
        .filter(({ arm }) => this.context.isTracedHandle(arm));
      if (traced.length === 0) {
        this.context.line("let _ = tracer;");
      } else {
        this.context.line("match self {");
        this.context.pushIndent();
        for (const { tag } of traced) {
          this.context.line(`Self::${this.context.unionVariant(tag)}(value) => tracer.edge(value),`);
        }
        this.context.line("_ => {},");
        this.context.popIndent();
        this.context.line("}");
      }
      this.context.popIndent();
      this.context.line("}");
      this.context.popIndent();
      this.context.line("}");
      if (this.context.isRustJsonCompatible({ kind: "union", unionId: union.id })) {
        this.context.line(`impl runtime::JsonValue for ${name} {`);
        this.context.pushIndent();
        this.context.line("fn write_json(&self, writer: &mut runtime::JsonWriter) {");
        this.context.pushIndent();
        this.context.line("match self {");
        this.context.pushIndent();
        union.arms.forEach((arm, tag) => {
          const variant = `Self::${this.context.unionVariant(tag)}`;
          if (arm.kind === "nullT" || arm.kind === "undefinedT") {
            this.context.line(`${variant} => writer.write_null(),`);
          } else {
            this.context.line(`${variant}(value) => runtime::JsonValue::write_json(value, writer),`);
          }
        });
        this.context.popIndent();
        this.context.line("}");
        this.context.popIndent();
        this.context.line("}");
        if (union.arms.some((arm) => arm.kind === "undefinedT")) {
          const undefinedVariants = union.arms.flatMap((arm, tag) =>
            arm.kind === "undefinedT" ? [`Self::${this.context.unionVariant(tag)}`] : []
          );
          this.context.line("fn is_json_undefined(&self) -> bool {");
          this.context.pushIndent();
          this.context.line(`matches!(self, ${undefinedVariants.join(" | ")})`);
          this.context.popIndent();
          this.context.line("}");
        }
        this.context.popIndent();
        this.context.line("}");
        this.context.line(`impl runtime::JsonDecode for ${name} {`);
        this.context.pushIndent();
        this.context.line("fn decode_json(node: &runtime::JsonNode, path: &str) -> Result<Self, String> {");
        this.context.pushIndent();
        union.arms.forEach((arm, tag) => {
          const variant = `Self::${this.context.unionVariant(tag)}`;
          if (arm.kind === "nullT") {
            this.context.line(`if matches!(node, runtime::JsonNode::Null) { return Ok(${variant}); }`);
          } else if (arm.kind !== "undefinedT") {
            const type = this.context.rustType(arm);
            this.context.line(`if let Ok(value) = <${type} as runtime::JsonDecode>::decode_json(node, path) { return Ok(${variant}(value)); }`);
          }
        });
        this.context.line(`Err(runtime::json_type_error(path, "${this.context.rustString(typeKey({ kind: "union", unionId: union.id }))}", node))`);
        this.context.popIndent();
        this.context.line("}");
        this.context.popIndent();
        this.context.line("}");
      }
      this.context.line(`impl runtime::HeapValue for ${name} {`);
      this.context.pushIndent();
      this.context.line("fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.context.pushIndent();
      this.context.line("runtime::Trace::trace(self, tracer);");
      this.context.popIndent();
      this.context.line("}");
      this.context.popIndent();
      this.context.line("}");
      this.context.line(`impl runtime::ArrayElement for ${name} {`);
      this.context.pushIndent();
      this.context.line("fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.context.pushIndent();
      this.context.line("runtime::Trace::trace(self, tracer);");
      this.context.popIndent();
      this.context.line("}");
      this.context.popIndent();
      this.context.line("}");
      this.emitUnionEquality(union);
      this.context.line("");
    }
  }

  emitUnionEquality(union: IrUnionDef): void {
    const name = this.context.unionName(union.id);
    this.context.line(`fn ${this.context.unionEqName(union.id)}(left: &${name}, right: &${name}, same_value: bool) -> bool {`);
    this.context.pushIndent();
    this.context.line("match (left, right) {");
    this.context.pushIndent();
    union.arms.forEach((arm, tag) => {
      const variant = this.context.unionVariant(tag);
      if (this.context.isUnit(arm)) {
        this.context.line(`(${name}::${variant}, ${name}::${variant}) => true,`);
        return;
      }
      let comparison: string;
      switch (arm.kind) {
        case "f64":
          comparison = "if same_value { runtime::number_same_value(*left, *right) } else { left == right }";
          break;
        case "bool":
        case "classval":
          comparison = "left == right";
          break;
        case "string":
          comparison = "left.as_ref() == right.as_ref()";
          break;
        case "array":
        case "bytes":
        case "map":
        case "set":
        case "stats":
        case "fileHandle":
        case "spawnRes":
        case "record":
        case "func":
        case "promise":
          comparison = "left.ptr_eq(right)";
          break;
        case "regex":
        case "symbol":
        case "url":
        case "searchParams":
          comparison = "std::rc::Rc::ptr_eq(left, right)";
          break;
        case "object":
          comparison = RUNTIME_ERROR_CLASSES.has(arm.className)
            ? "std::ptr::eq(left, right)"
            : arm.className === RUNTIME_EMITTER_CLASS ? "left == right" : "left.ptr_eq(right)";
          break;
        default:
          this.context.unsupported(`union equality arm '${arm.kind}'`);
      }
      this.context.line(`(${name}::${variant}(left), ${name}::${variant}(right)) => ${comparison},`);
    });
    this.context.line("_ => false,");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
  }

  emitRecordDefinitions(): void {
    for (const shape of this.context.records.values()) {
      // Pure index-signature records are represented directly by JsMap.
      // Hybrid shapes retain their declared slots and embed a map for extras.
      if (shape.indexValue !== undefined && shape.fields.length === 0) continue;
      const struct = mangleRecordStruct(shape.id);
      this.context.line(`struct ${struct} {`);
      this.context.pushIndent();
      for (const field of shape.fields) {
        const fieldType = this.context.isEdgeValue(field.type)
          ? `Option<${this.context.rustType(field.type)}>`
          : this.context.rustType(field.type);
        this.context.line(`${mangleField(field.name)}: ${fieldType},`);
      }
      if (shape.indexValue !== undefined) {
        const value = shape.indexValue.kind === "dyn"
          ? this.context.dynTypeName()
          : this.context.rustType(shape.indexValue);
        this.context.line(`${RUST_RECORD_OVERFLOW}: Option<runtime::JsMap<runtime::JsString, ${value}>>,`);
      }
      this.context.popIndent();
      this.context.line("}");
      this.context.line(`impl runtime::Trace for ${struct} {`);
      this.context.pushIndent();
      this.context.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.context.pushIndent();
      for (const field of shape.fields) {
        if (this.context.isEdgeValue(field.type)) {
          const name = mangleField(field.name);
          this.context.line(this.context.isTracedHandle(field.type)
            ? `if let Some(edge) = &self.${name} { tracer.edge(edge); }`
            : `if let Some(edge) = &self.${name} { runtime::Trace::trace(edge, tracer); }`);
        }
      }
      if (shape.indexValue !== undefined) {
        this.context.line(`if let Some(edge) = &self.${RUST_RECORD_OVERFLOW} { tracer.edge(edge); }`);
      }
      this.context.popIndent();
      this.context.line("}");
      this.context.popIndent();
      this.context.line("}");
      this.context.line(`impl runtime::ClearEdges for ${struct} {`);
      this.context.pushIndent();
      this.context.line("fn clear_edges(&mut self) {");
      this.context.pushIndent();
      for (const field of shape.fields) {
        if (this.context.isEdgeValue(field.type)) this.context.line(`self.${mangleField(field.name)} = None;`);
      }
      if (shape.indexValue !== undefined) this.context.line(`self.${RUST_RECORD_OVERFLOW} = None;`);
      this.context.popIndent();
      this.context.line("}");
      this.context.popIndent();
      this.context.line("}");
      if (this.context.isRustJsonCompatible({ kind: "record", shapeId: shape.id })) {
        this.context.line(`impl runtime::JsonObject for ${struct} {`);
        this.context.pushIndent();
        this.context.line("fn write_json_object(&self, writer: &mut runtime::JsonWriter) {");
        this.context.pushIndent();
        this.context.line(shape.tuple ? "writer.begin_array();" : "writer.begin_object();");
        this.context.line("let mut first = true;");
        const byName = new Map(shape.fields.map((field) => [field.name, field]));
        const fields = shape.tuple
          ? [...shape.fields].sort((left, right) => Number(left.name) - Number(right.name))
          : (shape.declaredOrder ?? shape.fields.map((field) => field.name))
            .map((name) => byName.get(name))
            .filter((field) => field !== undefined);
        for (const field of fields) {
          const stored = `self.${mangleField(field.name)}`;
          const value = this.context.isEdgeValue(field.type)
            ? `${stored}.as_ref().expect("scriptc: cleared live JSON record field")`
            : `&${stored}`;
          this.context.line(shape.tuple
            ? `writer.element(&mut first, ${value});`
            : `writer.property(&mut first, "${this.context.rustString(field.name)}", ${value});`);
        }
        if (shape.indexValue !== undefined) {
          this.context.line(`runtime::json_write_map_properties(writer, &mut first, self.${RUST_RECORD_OVERFLOW}.as_ref().expect("scriptc: cleared live record overflow"));`);
        }
        this.context.line(shape.tuple ? "writer.end_array();" : "writer.end_object();");
        this.context.popIndent();
        this.context.line("}");
        this.context.popIndent();
        this.context.line("}");
        this.context.line(`impl runtime::JsonObjectDecode for ${struct} {`);
        this.context.pushIndent();
        this.context.line("fn decode_json_object(node: &runtime::JsonNode, path: &str) -> Result<Self, String> {");
        this.context.pushIndent();
        this.context.line(shape.tuple
          ? "let values = runtime::json_expect_array(node, path)?;"
          : "let values = runtime::json_expect_object(node, path)?;");
        this.context.line(`Ok(${struct} {`);
        this.context.pushIndent();
        for (const field of shape.fields) {
          const type = this.context.rustType(field.type);
          let decoded: string;
          if (shape.tuple) {
            const index = Number(field.name);
            const node = `values.get(${index}).ok_or_else(|| format!("expected index ${index} at {path}"))?`;
            decoded = `<${type} as runtime::JsonDecode>::decode_json(${node}, &runtime::json_index_path(path, ${index}))?`;
          } else {
            const property = `"${this.context.rustString(field.name)}"`;
            const path = `runtime::json_property_path(path, ${property})`;
            const optionalTag = field.type.kind === "union"
              ? this.context.union(field.type.unionId).arms.findIndex((arm) => arm.kind === "undefinedT")
              : -1;
            if (optionalTag >= 0 && field.type.kind === "union") {
              decoded = `match runtime::json_object_field(values, ${property}) { Some(value) => <${type} as runtime::JsonDecode>::decode_json(value, &${path})?, None => ${type}::${this.context.unionVariant(optionalTag)}, }`;
            } else {
              decoded = `<${type} as runtime::JsonDecode>::decode_json(runtime::json_required_field(values, ${property}, path)?, &${path})?`;
            }
          }
          this.context.line(`${mangleField(field.name)}: ${this.context.isEdgeValue(field.type) ? `Some(${decoded})` : decoded},`);
        }
        if (shape.indexValue !== undefined) {
          const value = shape.indexValue.kind === "dyn"
            ? this.context.dynTypeName()
            : this.context.rustType(shape.indexValue);
          const declared = shape.fields.length === 0
            ? "false"
            : `matches!(key.as_str(), ${shape.fields.map((field) => `"${this.context.rustString(field.name)}"`).join(" | ")})`;
          this.context.line(`${RUST_RECORD_OVERFLOW}: Some({`);
          this.context.pushIndent();
          this.context.line(`let overflow: runtime::JsMap<runtime::JsString, ${value}> = runtime::map_new();`);
          this.context.line("for (key, node) in values {");
          this.context.pushIndent();
          this.context.line(`if ${declared} { continue; }`);
          this.context.line(`let value = <${value} as runtime::JsonDecode>::decode_json(node, &runtime::json_property_path(path, key))?;`);
          this.context.line("runtime::map_set_by(&overflow, runtime::string(key), value, |left, right| left.as_ref() == right.as_ref());");
          this.context.popIndent();
          this.context.line("}");
          this.context.line("overflow");
          this.context.popIndent();
          this.context.line("}),");
        }
        this.context.popIndent();
        this.context.line("})");
        this.context.popIndent();
        this.context.line("}");
        this.context.popIndent();
        this.context.line("}");
      }
      this.context.line("");
    }
  }

  emitClassDefinitions(): void {
    for (const meta of this.context.classMeta.values()) {
      if (meta.hierarchy && meta !== meta.root) continue;
      const cls = meta.def;
      const struct = mangleClassStruct(cls.name);
      const fields = meta.hierarchy ? this.context.hierarchyFields(meta) : cls.fields.map((field) => ({ owner: meta, field }));
      const emitterRooted = this.context.isEmitterClass(cls.name);
      this.context.line(`struct ${struct} {`);
      this.context.pushIndent();
      if (meta.hierarchy || emitterRooted) this.context.line("sc_class_pre: usize,");
      if (emitterRooted) this.context.line("sc_emitter: Option<ScEmitterRegistry>,");
      for (const { owner, field } of fields) {
        const fieldType = this.context.isEdgeValue(field.type)
          ? `Option<${this.context.rustType(field.type, cls.loc)}>`
          : this.context.rustType(field.type, cls.loc);
        this.context.line(`${this.context.classFieldStorageName(owner, field.name)}: ${fieldType},`);
      }
      this.context.popIndent();
      this.context.line("}");
      this.context.line(`impl runtime::Trace for ${struct} {`);
      this.context.pushIndent();
      this.context.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.context.pushIndent();
      if (emitterRooted) this.context.line("if let Some(edge) = &self.sc_emitter { tracer.edge(edge); }");
      for (const { owner, field } of fields) {
        if (!this.context.isEdgeValue(field.type)) continue;
        const name = this.context.classFieldStorageName(owner, field.name);
        this.context.line(this.context.isTracedHandle(field.type)
          ? `if let Some(edge) = &self.${name} { tracer.edge(edge); }`
          : `if let Some(edge) = &self.${name} { runtime::Trace::trace(edge, tracer); }`);
      }
      this.context.popIndent();
      this.context.line("}");
      this.context.popIndent();
      this.context.line("}");
      this.context.line(`impl runtime::ClearEdges for ${struct} {`);
      this.context.pushIndent();
      this.context.line("fn clear_edges(&mut self) {");
      this.context.pushIndent();
      if (emitterRooted) this.context.line("self.sc_emitter = None;");
      for (const { owner, field } of fields) {
        if (this.context.isEdgeValue(field.type)) this.context.line(`self.${this.context.classFieldStorageName(owner, field.name)} = None;`);
      }
      this.context.popIndent();
      this.context.line("}");
      this.context.popIndent();
      this.context.line("}");
      this.context.line("");
    }
  }

  emitErrorValueDefinition(): void {
    const roots = this.context.errorClassRoots();
    if (roots.length === 0) return;
    const name = this.context.errorValueName();
    this.context.line("#[derive(Clone)]");
    this.context.line(`enum ${name} {`);
    this.context.pushIndent();
    this.context.line("Builtin(runtime::JsError),");
    for (const root of roots) {
      this.context.line(`${this.context.errorValueVariant(root)}(runtime::Gc<${this.context.classStructName(root.def.name)}>),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`impl runtime::Trace for ${name} {`);
    this.context.pushIndent();
    this.context.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
    this.context.pushIndent();
    this.context.line("match self {");
    this.context.pushIndent();
    this.context.line("Self::Builtin(_) => {},");
    for (const root of roots) this.context.line(`Self::${this.context.errorValueVariant(root)}(value) => tracer.edge(value),`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`impl runtime::HeapValue for ${name} {`);
    this.context.pushIndent();
    this.context.line("fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) { runtime::Trace::trace(self, tracer); }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`impl runtime::ArrayElement for ${name} {`);
    this.context.pushIndent();
    this.context.line("fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) { runtime::Trace::trace(self, tracer); }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_error_is_class(value: &${name}, target: &str) -> bool {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Builtin(error) => runtime::error_is_class(error, target),`);
    for (const root of roots) {
      const classes = this.context.runtimeErrorClassNames(root.def.name);
      this.context.line(`${name}::${this.context.errorValueVariant(root)}(_) => matches!(target, ${classes.map((value) => `"${this.context.rustString(value)}"`).join(" | ")}),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.emitErrorValueStringHelper("name");
    this.emitErrorValueStringHelper("message");
    this.context.line(`fn sc_error_to_string(value: &${name}) -> runtime::JsString {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Builtin(error) => runtime::error_to_string(error),`);
    for (const root of roots) {
      const nameField = this.context.classFieldName(root.def.name, "name");
      const messageField = this.context.classFieldName(root.def.name, "message");
      this.context.line(`${name}::${this.context.errorValueVariant(root)}(value) => value.with(|object| runtime::error_to_string_parts(object.${nameField}.as_ref(), object.${messageField}.as_ref())),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_caught_error_value(caught: &runtime::Caught) -> ${name} {`);
    this.context.pushIndent();
    this.context.line(`if runtime::caught_is::<${name}>(caught) { return runtime::caught_narrow::<${name}>(caught); }`);
    this.context.line(`if runtime::caught_is::<runtime::JsError>(caught) { return ${name}::Builtin(runtime::caught_narrow::<runtime::JsError>(caught)); }`);
    for (const root of roots) {
      const typeName = `runtime::Gc<${this.context.classStructName(root.def.name)}>`;
      this.context.line(`if runtime::caught_is::<${typeName}>(caught) { return ${name}::${this.context.errorValueVariant(root)}(runtime::caught_narrow::<${typeName}>(caught)); }`);
    }
    this.context.line("unreachable!(\"scriptc invariant: caught value is not an Error\")");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_caught_is_error_class(caught: &runtime::Caught, target: &str) -> bool {`);
    this.context.pushIndent();
    this.context.line(`if runtime::caught_is::<${name}>(caught) { return sc_error_is_class(&runtime::caught_narrow::<${name}>(caught), target); }`);
    this.context.line("if runtime::caught_is::<runtime::JsError>(caught) { return runtime::caught_is_error_class(caught, target); }");
    for (const root of roots) {
      const typeName = `runtime::Gc<${this.context.classStructName(root.def.name)}>`;
      const classes = this.context.runtimeErrorClassNames(root.def.name);
      this.context.line(`if runtime::caught_is::<${typeName}>(caught) { return matches!(target, ${classes.map((value) => `"${this.context.rustString(value)}"`).join(" | ")}); }`);
    }
    this.context.line("false");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_caught_to_string(caught: &runtime::Caught) -> runtime::JsString {");
    this.context.pushIndent();
    this.context.line("if sc_caught_is_error_class(caught, \"Error\") { return sc_error_to_string(&sc_caught_error_value(caught)); }");
    this.context.line("runtime::caught_to_string(caught)");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("");
  }

  emitErrorValueStringHelper(field: "name" | "message"): void {
    const roots = this.context.errorClassRoots();
    const name = this.context.errorValueName();
    this.context.line(`fn sc_error_${field}(value: &${name}) -> runtime::JsString {`);
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line(`${name}::Builtin(error) => runtime::error_${field}(error),`);
    for (const root of roots) {
      const fieldName = this.context.classFieldName(root.def.name, field);
      this.context.line(`${name}::${this.context.errorValueVariant(root)}(value) => value.with(|object| object.${fieldName}.clone()),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
  }

  emitGlobals(): void {
    if (this.context.globals.size === 0 && this.context.internedClosureTargets.size === 0) return;
    this.context.line("std::thread_local! {");
    this.context.pushIndent();
    for (const global of this.context.globals.values()) {
      const name = mangleGlobal(global.id);
      switch (global.type.kind) {
        case "f64":
        case "date":
          this.context.line(`static ${name}: Cell<f64> = const { Cell::new(0.0) };`);
          break;
        case "bool":
          this.context.line(`static ${name}: Cell<bool> = const { Cell::new(false) };`);
          break;
        case "classval":
          this.context.line(`static ${name}: Cell<usize> = const { Cell::new(0) };`);
          break;
        case "string":
          this.context.line(`static ${name}: RefCell<runtime::JsString> = RefCell::new(runtime::empty_string());`);
          break;
        case "array":
        case "bytes":
        case "stats":
        case "fileHandle":
        case "spawnRes":
        case "map":
        case "set":
        case "record":
        case "object":
        case "union":
        case "func":
        case "promise":
        case "generator":
        case "regex":
        case "symbol":
        case "url":
        case "searchParams":
        case "dyn":
          this.context.line(`static ${name}: RefCell<Option<${this.context.rustType(global.type)}>> = const { RefCell::new(None) };`);
          break;
        default:
          this.context.unsupported(`global type '${global.type.kind}'`);
      }
    }
    for (const fnName of this.context.internedClosureTargets) {
      const shape = this.context.closureTargets.get(fnName);
      if (shape === undefined) this.context.unsupported(`missing interned closure shape '${fnName}'`);
      this.context.line(`static ${mangleFnClosure(fnName)}: RefCell<Option<runtime::Gc<${this.context.closureName(shape)}>>> = const { RefCell::new(None) };`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.line("");
  }

  emitFunction(fn: IrFunction): void {
    for (const local of fn.locals) {
      this.context.rustType(local.type, fn.loc);
    }
    const params: string[] = [];
    if (fn.captures !== undefined) {
      const shape = this.context.closureTargets.get(fn.name);
      if (shape === undefined) this.context.unsupported(`missing closure shape for '${fn.name}'`, fn.loc);
      params.push(`sc_self: runtime::Gc<${this.context.closureName(shape)}>`);
      for (const capture of fn.captures) {
        params.push(`${mangleLocal(capture.localId)}: runtime::JsCell<${this.context.rustType(capture.type, fn.loc)}>`);
      }
    }
    params.push(...fn.params.map((param) => {
      const local = fn.locals.find((candidate) => candidate.id === param.localId);
      if (local === undefined) this.context.unsupported(`missing parameter local '${param.localId}'`, fn.loc);
      const boxed = local.boxed || fn.async === true || fn.generator !== undefined;
      const name = boxed ? mangleRawParam(param.localId) : mangleLocal(param.localId);
      return `${local.mutable && !boxed ? "mut " : ""}${name}: ${this.context.rustType(param.type, fn.loc)}`;
    }));
    const returnType = this.context.rustType(fn.returnType, fn.loc);
    const generatorType: IrType | null = fn.generator === undefined ? null : {
      kind: "generator", yieldT: fn.generator.yieldT, retT: fn.returnType, nextT: fn.generator.nextT,
    };
    const emittedReturnType = fn.async ? `runtime::JsPromise<${returnType}>` :
      generatorType === null ? returnType : this.context.rustType(generatorType, fn.loc);
    this.context.line(`fn ${mangleFunction(fn.name)}(${params.join(", ")})${emittedReturnType === "()" ? "" : ` -> ${emittedReturnType}`} {`);
    this.context.pushIndent();
    this.context.setCurrentFunction(fn);
    for (const param of fn.params) {
      const local = fn.locals.find((candidate) => candidate.id === param.localId);
      if (local !== undefined && (local.boxed || fn.async === true || fn.generator !== undefined)) {
        this.context.line(`let ${mangleLocal(param.localId)} = runtime::cell_new(${mangleRawParam(param.localId)});`);
      }
    }
    if (fn.async) {
      const result = this.context.nextName("sc_async_result");
      const bodyResult = this.context.nextName("sc_async_result");
      const guard = this.context.nextName("sc_async_guard");
      this.context.line(`let ${result} = runtime::promise_new();`);
      this.context.line(`let ${bodyResult} = ${result}.clone();`);
      this.context.line(`let ${guard} = ${result}.clone();`);
      this.context.line(`runtime::promise_run_segment(&${guard}, move || {`);
      this.context.pushIndent();
      this.context.line(`let ${bodyResult} = ${bodyResult};`);
      this.context.setCurrentAsyncResult(bodyResult);
      this.context.setCurrentAsyncLocals(new Set([
        ...fn.params.map((param) => param.localId),
        ...(fn.captures ?? []).map((capture) => capture.localId),
      ]));
      this.context.emitAsyncStatements(fn.body);
      this.context.setCurrentAsyncResult(null);
      this.context.setCurrentAsyncLocals(null);
      this.context.popIndent();
      this.context.line("});");
      this.context.line(result);
    } else if (fn.generator !== undefined) {
      emitRustGeneratorBody(fn, this.context);
    } else {
      this.context.emitStatements(fn.body);
      if (fn.returnType.kind !== "void") {
        this.context.line(`unreachable!("scriptc invariant: function '${this.context.rustString(fn.name)}' fell through")`);
      }
    }
    this.context.setCurrentFunction(null);
    this.context.popIndent();
    this.context.line("}");
  }

}
