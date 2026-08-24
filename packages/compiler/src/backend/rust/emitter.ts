import type {
  IrClassDef,
  IrExpr,
  IrFunction,
  IrGlobal,
  IrModule,
  IrRecordShape,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "../../ir/nodes.js";
import { RUNTIME_ERROR_CLASSES, typeKey } from "../../ir/nodes.js";
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

type IrFuncType = Extract<IrType, { kind: "func" }>;

interface RustClosureShape {
  readonly index: number;
  readonly type: IrFuncType;
  readonly targets: IrFunction[];
}

interface RustClassMeta {
  readonly def: IrClassDef;
  base: RustClassMeta | null;
  readonly children: RustClassMeta[];
  root: RustClassMeta;
  pre: number;
  post: number;
  hierarchy: boolean;
  readonly slots: RustVtSlot[];
}

interface RustVtSlot {
  readonly method: string;
  readonly declarer: RustClassMeta;
  readonly fn: IrFunction;
}

/** A valid IR construct that the incremental Rust backend has not ported yet. */
export class RustUnsupportedError extends Error {
  constructor(
    readonly kind: string,
    readonly loc?: SrcLoc,
  ) {
    super(`rust backend does not support ${kind} yet`);
    this.name = "RustUnsupportedError";
  }
}

/** Emit deterministic, safe Rust. Unsupported IR always refuses explicitly. */
export function emitRustModule(mod: IrModule): string {
  return new RustEmitter(mod).emit();
}

class RustEmitter {
  private readonly lines: string[] = [];
  private readonly functions = new Map<string, IrFunction>();
  private readonly classes = new Map<string, IrClassDef>();
  private readonly classMeta = new Map<string, RustClassMeta>();
  private readonly globals = new Map<string, IrGlobal>();
  private readonly records = new Map<string, IrRecordShape>();
  private readonly unions = new Map<string, IrUnionDef>();
  private readonly closureShapes = new Map<string, RustClosureShape>();
  private readonly closureTargets = new Map<string, RustClosureShape>();
  private readonly internedClosureTargets = new Set<string>();
  private indent = 0;
  private temporary = 0;
  private currentFunction: IrFunction | null = null;
  private capturedReturnDepth = 0;
  private readonly loopTargets: { id: number; breakLabel: string; continueBlock: string | null }[] = [];
  private readonly completionLoopBoundaries: number[] = [];
  private nextLoopTargetId = 0;

  constructor(private readonly mod: IrModule) {
    for (const fn of mod.functions) this.functions.set(fn.name, fn);
    for (const cls of mod.classes ?? []) {
      if (!cls.runtime) {
        this.classes.set(cls.name, cls);
        this.classMeta.set(cls.name, {
          def: cls,
          base: null,
          children: [],
          root: undefined as unknown as RustClassMeta,
          pre: 0,
          post: 0,
          hierarchy: false,
          slots: [],
        });
      }
    }
    for (const global of mod.globals ?? []) this.globals.set(global.id, global);
    for (const record of mod.records ?? []) this.records.set(record.id, record);
    for (const union of mod.unions ?? []) this.unions.set(union.id, union);
    this.buildClassGraph();
    this.discoverClosures();
  }

  emit(): string {
    this.checkModuleSurface();
    this.line("#![forbid(unsafe_code)]");
    this.line("");
    this.line("use scriptc_runtime as runtime;");
    if (this.globals.size > 0 || this.internedClosureTargets.size > 0) {
      this.line("use std::cell::{Cell, RefCell};");
    }
    this.line("");
    this.emitClosureDefinitions();
    this.emitUnionDefinitions();
    this.emitRecordDefinitions();
    this.emitClassDefinitions();
    this.emitGlobals();
    for (const fn of this.mod.functions) {
      if (fn.captures !== undefined && !this.closureTargets.has(fn.name)) continue;
      // The frontend may intern this helper while probing process.env as a
      // receiver, even when every actual read becomes process.envGet. Its
      // indexed-record body is irrelevant unless a whole env value escapes.
      if (fn.name.startsWith("%env.snapshot.") && !this.isFunctionReferenced(fn.name)) continue;
      this.emitFunction(fn);
      this.line("");
    }
    const entry = this.functions.get(this.mod.entry);
    if (entry === undefined) this.unsupported(`missing entry '${this.mod.entry}'`);
    if (entry.params.length !== 0 || entry.returnType.kind !== "void") {
      this.unsupported("entry signature", entry.loc);
    }
    this.line("fn main() {");
    this.indent += 1;
    this.line(`${mangleFunction(entry.name)}();`);
    for (const global of this.globals.values()) {
      if (this.isHeapRoot(global.type)) {
        this.line(`${mangleGlobal(global.id)}.with(|slot| *slot.borrow_mut() = None);`);
      }
    }
    for (const fnName of this.internedClosureTargets) {
      this.line(`${mangleFnClosure(fnName)}.with(|slot| *slot.borrow_mut() = None);`);
    }
    this.line("runtime::finish();");
    this.indent -= 1;
    this.line("}");
    return `${this.lines.join("\n")}\n`;
  }

  private checkModuleSurface(): void {
    for (const cls of this.classes.values()) {
      if (cls.base !== undefined && !this.classes.has(cls.base)) {
        this.unsupported(`inheritance from runtime-provided class '${cls.base}'`, cls.loc);
      }
    }
    if ((this.mod.ffiImports?.length ?? 0) > 0) this.unsupported("native FFI");
    if (this.mod.embedded !== undefined) this.unsupported("embedded dynamic modules");
    if (this.mod.lib !== undefined) this.unsupported("library mode");
  }

  private buildClassGraph(): void {
    for (const meta of this.classMeta.values()) {
      if (meta.def.base === undefined) continue;
      const base = this.classMeta.get(meta.def.base);
      if (base === undefined) continue;
      meta.base = base;
      base.children.push(meta);
    }
    let pre = 0;
    const number = (meta: RustClassMeta, root: RustClassMeta): void => {
      meta.root = root;
      meta.pre = pre++;
      for (const child of meta.children) number(child, root);
      meta.post = pre - 1;
    };
    for (const meta of this.classMeta.values()) {
      if (meta.base === null) number(meta, meta);
    }
    for (const meta of this.classMeta.values()) {
      meta.hierarchy = meta.base !== null || meta.children.length > 0;
    }
    const declares = (meta: RustClassMeta, method: string): boolean => meta.def.methods?.includes(method) ?? false;
    const declaredBelow = (meta: RustClassMeta, method: string): boolean =>
      meta.children.some((child) => declares(child, method) || declaredBelow(child, method));
    const collectSlots = (meta: RustClassMeta, root: RustClassMeta): void => {
      for (const method of meta.def.methods ?? []) {
        let inherited = false;
        for (let ancestor = meta.base; ancestor !== null; ancestor = ancestor.base) {
          inherited ||= declares(ancestor, method);
        }
        if (!inherited && declaredBelow(meta, method)) {
          let fn = this.functions.get(`%${meta.def.name}.${method}`);
          if (fn === undefined && meta.def.abstractMethods?.includes(method)) {
            const findImplementation = (candidate: RustClassMeta): IrFunction | undefined => {
              for (const child of candidate.children) {
                const implementation = child.def.methods?.includes(method) && !child.def.abstractMethods?.includes(method)
                  ? this.functions.get(`%${child.def.name}.${method}`)
                  : undefined;
                const found = implementation ?? findImplementation(child);
                if (found !== undefined) return found;
              }
              return undefined;
            };
            fn = findImplementation(meta);
            if (fn === undefined) continue;
          }
          if (fn === undefined) this.unsupported(`missing virtual method '${meta.def.name}.${method}'`, meta.def.loc);
          root.slots.push({ method, declarer: meta, fn });
        }
      }
      for (const child of meta.children) collectSlots(child, root);
    };
    for (const meta of this.classMeta.values()) {
      if (meta.base === null && meta.hierarchy) collectSlots(meta, meta);
    }
  }

  private discoverClosures(): void {
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node.kind === "closure") {
        const type = node.type as IrType | undefined;
        const fnName = node.fnName;
        if (type?.kind !== "func" || typeof fnName !== "string") {
          this.unsupported("malformed closure IR");
        }
        const target = this.functions.get(fnName);
        if (target === undefined) this.unsupported(`unknown closure target '${fnName}'`);
        const key = typeKey(type);
        let shape = this.closureShapes.get(key);
        if (shape === undefined) {
          shape = { index: this.closureShapes.size, type, targets: [] };
          this.closureShapes.set(key, shape);
        }
        if (!shape.targets.some((candidate) => candidate.name === target.name)) {
          shape.targets.push(target);
        }
        const existing = this.closureTargets.get(target.name);
        if (existing !== undefined && existing !== shape) {
          this.unsupported(`closure target '${target.name}' with multiple signatures`, target.loc);
        }
        this.closureTargets.set(target.name, shape);
        if (target.captures === undefined) this.internedClosureTargets.add(target.name);
      }
      for (const child of Object.values(node)) visit(child);
    };
    for (const fn of this.mod.functions) visit(fn.body);
  }

  private isFunctionReferenced(name: string): boolean {
    let found = false;
    const visit = (value: unknown): void => {
      if (found || value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const node = value as Record<string, unknown>;
      if ((node.kind === "call" && node.callee === name) || (node.kind === "closure" && node.fnName === name)) {
        found = true;
        return;
      }
      for (const child of Object.values(node)) visit(child);
    };
    for (const fn of this.mod.functions) {
      if (fn.name !== name) visit(fn.body);
    }
    return found;
  }

  private emitClosureDefinitions(): void {
    for (const shape of this.closureShapes.values()) {
      const name = this.closureName(shape);
      this.line(`enum ${name} {`);
      this.indent += 1;
      for (const target of shape.targets) {
        const captures = target.captures ?? [];
        if (captures.length === 0) {
          this.line(`${this.closureVariant(target)},`);
        } else {
          const fields = captures.map((capture, index) =>
            `${this.captureField(index)}: Option<runtime::JsCell<${this.rustType(capture.type, target.loc)}>>`,
          ).join(", ");
          this.line(`${this.closureVariant(target)} { ${fields} },`);
        }
      }
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::Trace for ${name} {`);
      this.indent += 1;
      this.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      const capturing = shape.targets.filter((target) => (target.captures?.length ?? 0) > 0);
      if (capturing.length === 0) {
        this.line("let _ = tracer;");
      } else {
        this.line("match self {");
        this.indent += 1;
        for (const target of capturing) {
          const fields = (target.captures ?? []).map((_, index) => this.captureField(index));
          this.line(`Self::${this.closureVariant(target)} { ${fields.join(", ")} } => {`);
          this.indent += 1;
          for (const field of fields) {
            this.line(`if let Some(edge) = ${field} { tracer.edge(edge); }`);
          }
          this.indent -= 1;
          this.line("},");
        }
        this.line("_ => {},");
        this.indent -= 1;
        this.line("}");
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::ClearEdges for ${name} {`);
      this.indent += 1;
      this.line("fn clear_edges(&mut self) {");
      this.indent += 1;
      if (capturing.length > 0) {
        this.line("match self {");
        this.indent += 1;
        for (const target of capturing) {
          const fields = (target.captures ?? []).map((_, index) => this.captureField(index));
          this.line(`Self::${this.closureVariant(target)} { ${fields.join(", ")} } => {`);
          this.indent += 1;
          for (const field of fields) this.line(`*${field} = None;`);
          this.indent -= 1;
          this.line("},");
        }
        this.line("_ => {},");
        this.indent -= 1;
        this.line("}");
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line("");
    }
  }

  private emitUnionDefinitions(): void {
    for (const union of this.unions.values()) {
      const name = this.unionName(union.id);
      this.line("#[derive(Clone)]");
      this.line(`enum ${name} {`);
      this.indent += 1;
      union.arms.forEach((arm, tag) => {
        this.ensureUnionArm(arm);
        this.line(this.isUnit(arm)
          ? `${this.unionVariant(tag)},`
          : `${this.unionVariant(tag)}(${this.rustType(arm)}),`);
      });
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::Trace for ${name} {`);
      this.indent += 1;
      this.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      const traced = union.arms
        .map((arm, tag) => ({ arm, tag }))
        .filter(({ arm }) => this.isTracedHandle(arm));
      if (traced.length === 0) {
        this.line("let _ = tracer;");
      } else {
        this.line("match self {");
        this.indent += 1;
        for (const { tag } of traced) {
          this.line(`Self::${this.unionVariant(tag)}(value) => tracer.edge(value),`);
        }
        this.line("_ => {},");
        this.indent -= 1;
        this.line("}");
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      if (this.isRustJsonCompatible({ kind: "union", unionId: union.id })) {
        this.line(`impl runtime::JsonValue for ${name} {`);
        this.indent += 1;
        this.line("fn write_json(&self, writer: &mut runtime::JsonWriter) {");
        this.indent += 1;
        this.line("match self {");
        this.indent += 1;
        union.arms.forEach((arm, tag) => {
          const variant = `Self::${this.unionVariant(tag)}`;
          if (arm.kind === "nullT" || arm.kind === "undefinedT") {
            this.line(`${variant} => writer.write_null(),`);
          } else {
            this.line(`${variant}(value) => runtime::JsonValue::write_json(value, writer),`);
          }
        });
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
        if (union.arms.some((arm) => arm.kind === "undefinedT")) {
          const undefinedVariants = union.arms.flatMap((arm, tag) =>
            arm.kind === "undefinedT" ? [`Self::${this.unionVariant(tag)}`] : []
          );
          this.line("fn is_json_undefined(&self) -> bool {");
          this.indent += 1;
          this.line(`matches!(self, ${undefinedVariants.join(" | ")})`);
          this.indent -= 1;
          this.line("}");
        }
        this.indent -= 1;
        this.line("}");
        this.line(`impl runtime::JsonDecode for ${name} {`);
        this.indent += 1;
        this.line("fn decode_json(node: &runtime::JsonNode, path: &str) -> Result<Self, String> {");
        this.indent += 1;
        union.arms.forEach((arm, tag) => {
          const variant = `Self::${this.unionVariant(tag)}`;
          if (arm.kind === "nullT") {
            this.line(`if matches!(node, runtime::JsonNode::Null) { return Ok(${variant}); }`);
          } else if (arm.kind !== "undefinedT") {
            const type = this.rustType(arm);
            this.line(`if let Ok(value) = <${type} as runtime::JsonDecode>::decode_json(node, path) { return Ok(${variant}(value)); }`);
          }
        });
        this.line(`Err(runtime::json_type_error(path, "${this.rustString(typeKey({ kind: "union", unionId: union.id }))}", node))`);
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
      }
      this.line(`impl runtime::HeapValue for ${name} {`);
      this.indent += 1;
      this.line("fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      this.line("runtime::Trace::trace(self, tracer);");
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::ArrayElement for ${name} {`);
      this.indent += 1;
      this.line("fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      this.line("runtime::Trace::trace(self, tracer);");
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.emitUnionEquality(union);
      this.line("");
    }
  }

  private emitUnionEquality(union: IrUnionDef): void {
    const name = this.unionName(union.id);
    this.line(`fn ${this.unionEqName(union.id)}(left: &${name}, right: &${name}, same_value: bool) -> bool {`);
    this.indent += 1;
    this.line("match (left, right) {");
    this.indent += 1;
    union.arms.forEach((arm, tag) => {
      const variant = this.unionVariant(tag);
      if (this.isUnit(arm)) {
        this.line(`(${name}::${variant}, ${name}::${variant}) => true,`);
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
        case "map":
        case "set":
        case "stats":
        case "record":
        case "object":
        case "func":
          comparison = "left.ptr_eq(right)";
          break;
        default:
          this.unsupported(`union equality arm '${arm.kind}'`);
      }
      this.line(`(${name}::${variant}(left), ${name}::${variant}(right)) => ${comparison},`);
    });
    this.line("_ => false,");
    this.indent -= 1;
    this.line("}");
    this.indent -= 1;
    this.line("}");
  }

  private emitRecordDefinitions(): void {
    for (const shape of this.records.values()) {
      // Some intrinsic-only surfaces, notably process.env, carry an indexed
      // record type through the IR even though every operation lowers to a
      // dedicated libCall. Do not reject those unused nominal shapes here;
      // rustType still fences an indexed record if a value actually escapes.
      if (shape.indexValue !== undefined) continue;
      const struct = mangleRecordStruct(shape.id);
      this.line(`struct ${struct} {`);
      this.indent += 1;
      for (const field of shape.fields) {
        const fieldType = this.isEdgeValue(field.type)
          ? `Option<${this.rustType(field.type)}>`
          : this.rustType(field.type);
        this.line(`${mangleField(field.name)}: ${fieldType},`);
      }
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::Trace for ${struct} {`);
      this.indent += 1;
      this.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      for (const field of shape.fields) {
        if (this.isEdgeValue(field.type)) {
          const name = mangleField(field.name);
          this.line(this.isTracedHandle(field.type)
            ? `if let Some(edge) = &self.${name} { tracer.edge(edge); }`
            : `if let Some(edge) = &self.${name} { runtime::Trace::trace(edge, tracer); }`);
        }
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::ClearEdges for ${struct} {`);
      this.indent += 1;
      this.line("fn clear_edges(&mut self) {");
      this.indent += 1;
      for (const field of shape.fields) {
        if (this.isEdgeValue(field.type)) this.line(`self.${mangleField(field.name)} = None;`);
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      if (this.isRustJsonCompatible({ kind: "record", shapeId: shape.id })) {
        this.line(`impl runtime::JsonObject for ${struct} {`);
        this.indent += 1;
        this.line("fn write_json_object(&self, writer: &mut runtime::JsonWriter) {");
        this.indent += 1;
        this.line(shape.tuple ? "writer.begin_array();" : "writer.begin_object();");
        this.line("let mut first = true;");
        const byName = new Map(shape.fields.map((field) => [field.name, field]));
        const fields = shape.tuple
          ? [...shape.fields].sort((left, right) => Number(left.name) - Number(right.name))
          : (shape.declaredOrder ?? shape.fields.map((field) => field.name))
            .map((name) => byName.get(name))
            .filter((field) => field !== undefined);
        for (const field of fields) {
          const stored = `self.${mangleField(field.name)}`;
          const value = this.isEdgeValue(field.type)
            ? `${stored}.as_ref().expect("scriptc: cleared live JSON record field")`
            : `&${stored}`;
          this.line(shape.tuple
            ? `writer.element(&mut first, ${value});`
            : `writer.property(&mut first, "${this.rustString(field.name)}", ${value});`);
        }
        this.line(shape.tuple ? "writer.end_array();" : "writer.end_object();");
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
        this.line(`impl runtime::JsonObjectDecode for ${struct} {`);
        this.indent += 1;
        this.line("fn decode_json_object(node: &runtime::JsonNode, path: &str) -> Result<Self, String> {");
        this.indent += 1;
        this.line(shape.tuple
          ? "let values = runtime::json_expect_array(node, path)?;"
          : "let values = runtime::json_expect_object(node, path)?;");
        this.line(`Ok(${struct} {`);
        this.indent += 1;
        for (const field of shape.fields) {
          const type = this.rustType(field.type);
          let decoded: string;
          if (shape.tuple) {
            const index = Number(field.name);
            const node = `values.get(${index}).ok_or_else(|| format!("expected index ${index} at {path}"))?`;
            decoded = `<${type} as runtime::JsonDecode>::decode_json(${node}, &runtime::json_index_path(path, ${index}))?`;
          } else {
            const property = `"${this.rustString(field.name)}"`;
            const path = `runtime::json_property_path(path, ${property})`;
            const optionalTag = field.type.kind === "union"
              ? this.union(field.type.unionId).arms.findIndex((arm) => arm.kind === "undefinedT")
              : -1;
            if (optionalTag >= 0 && field.type.kind === "union") {
              decoded = `match runtime::json_object_field(values, ${property}) { Some(value) => <${type} as runtime::JsonDecode>::decode_json(value, &${path})?, None => ${type}::${this.unionVariant(optionalTag)}, }`;
            } else {
              decoded = `<${type} as runtime::JsonDecode>::decode_json(runtime::json_required_field(values, ${property}, path)?, &${path})?`;
            }
          }
          this.line(`${mangleField(field.name)}: ${this.isEdgeValue(field.type) ? `Some(${decoded})` : decoded},`);
        }
        this.indent -= 1;
        this.line("})");
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
      }
      this.line("");
    }
  }

  private emitClassDefinitions(): void {
    for (const meta of this.classMeta.values()) {
      if (meta.hierarchy && meta !== meta.root) continue;
      const cls = meta.def;
      const struct = mangleClassStruct(cls.name);
      const fields = meta.hierarchy ? this.hierarchyFields(meta) : cls.fields.map((field) => ({ owner: meta, field }));
      this.line(`struct ${struct} {`);
      this.indent += 1;
      if (meta.hierarchy) this.line("sc_class_pre: usize,");
      for (const { owner, field } of fields) {
        const fieldType = this.isEdgeValue(field.type)
          ? `Option<${this.rustType(field.type, cls.loc)}>`
          : this.rustType(field.type, cls.loc);
        this.line(`${this.classFieldStorageName(owner, field.name)}: ${fieldType},`);
      }
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::Trace for ${struct} {`);
      this.indent += 1;
      this.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
      this.indent += 1;
      for (const { owner, field } of fields) {
        if (!this.isEdgeValue(field.type)) continue;
        const name = this.classFieldStorageName(owner, field.name);
        this.line(this.isTracedHandle(field.type)
          ? `if let Some(edge) = &self.${name} { tracer.edge(edge); }`
          : `if let Some(edge) = &self.${name} { runtime::Trace::trace(edge, tracer); }`);
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line(`impl runtime::ClearEdges for ${struct} {`);
      this.indent += 1;
      this.line("fn clear_edges(&mut self) {");
      this.indent += 1;
      for (const { owner, field } of fields) {
        if (this.isEdgeValue(field.type)) this.line(`self.${this.classFieldStorageName(owner, field.name)} = None;`);
      }
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("}");
      this.line("");
    }
  }

  private emitGlobals(): void {
    if (this.globals.size === 0 && this.internedClosureTargets.size === 0) return;
    this.line("std::thread_local! {");
    this.indent += 1;
    for (const global of this.globals.values()) {
      const name = mangleGlobal(global.id);
      switch (global.type.kind) {
        case "f64":
          this.line(`static ${name}: Cell<f64> = const { Cell::new(0.0) };`);
          break;
        case "bool":
          this.line(`static ${name}: Cell<bool> = const { Cell::new(false) };`);
          break;
        case "classval":
          this.line(`static ${name}: Cell<usize> = const { Cell::new(0) };`);
          break;
        case "string":
          this.line(`static ${name}: RefCell<runtime::JsString> = RefCell::new(runtime::empty_string());`);
          break;
        case "array":
        case "bytes":
        case "stats":
        case "map":
        case "set":
        case "record":
        case "object":
        case "union":
        case "func":
          this.line(`static ${name}: RefCell<Option<${this.rustType(global.type)}>> = const { RefCell::new(None) };`);
          break;
        default:
          this.unsupported(`global type '${global.type.kind}'`);
      }
    }
    for (const fnName of this.internedClosureTargets) {
      const shape = this.closureTargets.get(fnName);
      if (shape === undefined) this.unsupported(`missing interned closure shape '${fnName}'`);
      this.line(`static ${mangleFnClosure(fnName)}: RefCell<Option<runtime::Gc<${this.closureName(shape)}>>> = const { RefCell::new(None) };`);
    }
    this.indent -= 1;
    this.line("}");
    this.line("");
  }

  private emitFunction(fn: IrFunction): void {
    if (fn.async) this.unsupported(`async function '${fn.name}'`, fn.loc);
    if (fn.generator !== undefined) this.unsupported(`generator function '${fn.name}'`, fn.loc);
    for (const local of fn.locals) {
      this.rustType(local.type, fn.loc);
    }
    const params: string[] = [];
    if (fn.captures !== undefined) {
      const shape = this.closureTargets.get(fn.name);
      if (shape === undefined) this.unsupported(`missing closure shape for '${fn.name}'`, fn.loc);
      params.push(`sc_self: runtime::Gc<${this.closureName(shape)}>`);
      for (const capture of fn.captures) {
        params.push(`${mangleLocal(capture.localId)}: runtime::JsCell<${this.rustType(capture.type, fn.loc)}>`);
      }
    }
    params.push(...fn.params.map((param) => {
      const local = fn.locals.find((candidate) => candidate.id === param.localId);
      if (local === undefined) this.unsupported(`missing parameter local '${param.localId}'`, fn.loc);
      const name = local.boxed ? mangleRawParam(param.localId) : mangleLocal(param.localId);
      return `${local.mutable && !local.boxed ? "mut " : ""}${name}: ${this.rustType(param.type, fn.loc)}`;
    }));
    const returnType = this.rustType(fn.returnType, fn.loc);
    this.line(`fn ${mangleFunction(fn.name)}(${params.join(", ")})${returnType === "()" ? "" : ` -> ${returnType}`} {`);
    this.indent += 1;
    this.currentFunction = fn;
    for (const param of fn.params) {
      const local = fn.locals.find((candidate) => candidate.id === param.localId);
      if (local?.boxed) {
        this.line(`let ${mangleLocal(param.localId)} = runtime::cell_new(${mangleRawParam(param.localId)});`);
      }
    }
    this.emitStatements(fn.body);
    if (fn.returnType.kind !== "void") {
      this.line(`unreachable!("scriptc invariant: function '${this.rustString(fn.name)}' fell through")`);
    }
    this.currentFunction = null;
    this.indent -= 1;
    this.line("}");
  }

  private emitStatements(statements: readonly IrStmt[]): void {
    for (const stmt of statements) this.emitStatement(stmt);
  }

  private emitStatement(stmt: IrStmt): void {
    switch (stmt.kind) {
      case "varDecl": {
        const local = this.local(stmt.localId, stmt.loc);
        if (local.boxed) {
          const init = stmt.init === null
            ? "runtime::cell_empty()"
            : `runtime::cell_new(${this.emitExpr(stmt.init)})`;
          this.line(`let ${local.mutable ? "mut " : ""}${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, stmt.loc)}> = ${init};`);
          return;
        }
        const mutable = local.mutable ? "mut " : "";
        const init = stmt.init === null
          ? this.defaultValue(local.type, stmt.loc)
          : this.emitExpr(stmt.init);
        this.line(`let ${mutable}${mangleLocal(local.id)}: ${this.rustType(local.type, stmt.loc)} = ${init};`);
        return;
      }
      case "assign":
        this.emitAssignment(stmt.localId, this.emitExpr(stmt.value), stmt.loc);
        return;
      case "exprStmt":
        this.line(`let _ = ${this.emitExpr(stmt.expr)};`);
        return;
      case "if":
        this.line(`if ${this.emitExpr(stmt.cond)} {`);
        this.indent += 1;
        this.emitStatements(stmt.then);
        this.indent -= 1;
        if (stmt.else_ === null) {
          this.line("}");
        } else {
          this.line("} else {");
          this.indent += 1;
          this.emitStatements(stmt.else_);
          this.indent -= 1;
          this.line("}");
        }
        return;
      case "while":
        if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled while", stmt.loc);
        {
          const loopLabel = `sc_loop_${this.temporary++}`;
          this.line(`'${loopLabel}: while ${this.emitExpr(stmt.cond)} {`);
          this.indent += 1;
          this.loopTargets.push({ id: this.nextLoopTargetId++, breakLabel: loopLabel, continueBlock: null });
          this.emitStatements(stmt.body);
          this.loopTargets.pop();
          this.indent -= 1;
          this.line("}");
        }
        return;
      case "for":
        if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled for", stmt.loc);
        this.line("{");
        this.indent += 1;
        if (stmt.init !== null) this.emitStatement(stmt.init);
        const loopLabel = `sc_loop_${this.temporary++}`;
        this.line(`'${loopLabel}: while ${stmt.cond === null ? "true" : this.emitExpr(stmt.cond)} {`);
        this.indent += 1;
        const continueTarget = `sc_continue_${this.temporary++}`;
        this.line(`'${continueTarget}: {`);
        this.indent += 1;
        this.loopTargets.push({ id: this.nextLoopTargetId++, breakLabel: loopLabel, continueBlock: continueTarget });
        this.emitStatements(stmt.body);
        this.loopTargets.pop();
        this.indent -= 1;
        this.line("}");
        if (stmt.init?.kind === "varDecl") {
          const initLocal = this.local(stmt.init.localId, stmt.loc);
          if (initLocal.boxed) {
            const name = mangleLocal(initLocal.id);
            this.line(`${name} = runtime::cell_new(runtime::cell_get(&${name}));`);
          }
        }
        if (stmt.update !== null) this.emitStatement(stmt.update);
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
        return;
      case "forOf": {
        if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled for-of", stmt.loc);
        if (stmt.iterable.type.kind !== "array") this.unsupported("for-of over a non-array", stmt.loc);
        const local = this.local(stmt.localId, stmt.loc);
        const array = `sc_rt_${this.temporary++}`;
        const index = `sc_rt_${this.temporary++}`;
        const loopLabel = `sc_loop_${this.temporary++}`;
        const continueTarget = `sc_continue_${this.temporary++}`;
        this.line("{");
        this.indent += 1;
        this.line(`let ${array} = ${this.emitExpr(stmt.iterable)};`);
        this.line(`let mut ${index} = 0.0_f64;`);
        this.line(`'${loopLabel}: while ${index} < runtime::array_len(&${array}) {`);
        this.indent += 1;
        this.line(`'${continueTarget}: {`);
        this.indent += 1;
        this.line(local.boxed
          ? `let ${mangleLocal(local.id)}: runtime::JsCell<${this.rustType(local.type, stmt.loc)}> = runtime::cell_new(runtime::array_get(&${array}, ${index}));`
          : `let ${mangleLocal(local.id)}: ${this.rustType(local.type, stmt.loc)} = runtime::array_get(&${array}, ${index});`);
        this.loopTargets.push({ id: this.nextLoopTargetId++, breakLabel: loopLabel, continueBlock: continueTarget });
        this.emitStatements(stmt.body);
        this.loopTargets.pop();
        this.indent -= 1;
        this.line("}");
        this.line(`${index} += 1.0_f64;`);
        this.indent -= 1;
        this.line("}");
        this.indent -= 1;
        this.line("}");
        return;
      }
      case "arraySet": {
        if (stmt.arr.type.kind !== "array") this.unsupported("arraySet on a non-array", stmt.loc);
        const array = `sc_rt_${this.temporary++}`;
        const index = `sc_rt_${this.temporary++}`;
        const value = `sc_rt_${this.temporary++}`;
        this.line(`{ let ${array} = ${this.emitExpr(stmt.arr)}; let ${index} = ${this.emitExpr(stmt.index)}; let ${value} = ${this.emitExpr(stmt.value)}; runtime::array_set(&${array}, ${index}, ${value}); }`);
        return;
      }
      case "bytesSet": {
        if (stmt.arr.type.kind !== "bytes") this.unsupported("bytesSet on non-bytes", stmt.loc);
        const bytes = `sc_rt_${this.temporary++}`;
        const index = `sc_rt_${this.temporary++}`;
        const value = `sc_rt_${this.temporary++}`;
        this.line(`{ let ${bytes} = ${this.emitExpr(stmt.arr)}; let ${index} = ${this.emitExpr(stmt.index)}; let ${value} = ${this.emitExpr(stmt.value)}; runtime::bytes_set(&${bytes}, ${index}, ${value}); }`);
        return;
      }
      case "recordSet": {
        const shape = this.records.get(stmt.shapeId);
        const field = shape?.fields.find((candidate) => candidate.name === stmt.field);
        if (shape === undefined || field === undefined) this.unsupported(`unknown record field '${stmt.shapeId}.${stmt.field}'`, stmt.loc);
        const object = `sc_rt_${this.temporary++}`;
        const value = `sc_rt_${this.temporary++}`;
        const stored = this.isEdgeValue(field.type) ? `Some(${value})` : value;
        this.line(`{ let ${object} = ${this.emitExpr(stmt.obj)}; let ${value} = ${this.emitExpr(stmt.value)}; ${object}.with_mut(|record| record.${mangleField(field.name)} = ${stored}); }`);
        return;
      }
      case "fieldSet": {
        const cls = this.classDef(stmt.className, stmt.loc);
        const field = cls.fields.find((candidate) => candidate.name === stmt.field);
        if (field === undefined) this.unsupported(`unknown class field '${stmt.className}.${stmt.field}'`, stmt.loc);
        const name = this.classFieldName(stmt.className, field.name, stmt.loc);
        const object = `sc_rt_${this.temporary++}`;
        const value = `sc_rt_${this.temporary++}`;
        const stored = this.isEdgeValue(field.type) ? `Some(${value})` : value;
        this.line(`{ let ${object} = ${this.emitExpr(stmt.obj)}; let ${value} = ${this.emitExpr(stmt.value)}; ${object}.with_mut(|object| object.${name} = ${stored}); }`);
        return;
      }
      case "throw":
        this.line(`runtime::throw_value(${this.emitExpr(stmt.value)});`);
        return;
      case "rethrow":
        this.line(`runtime::rethrow_caught(${this.emitRead(stmt.localId, { kind: "caught" }, stmt.loc)});`);
        return;
      case "return": {
        const value = stmt.value === null ? "()" : this.emitExpr(stmt.value);
        this.line(this.capturedReturnDepth > 0
          ? `return runtime::Completion::Return(${value});`
          : stmt.value === null ? "return;" : `return ${value};`);
        return;
      }
      case "break":
        if (stmt.label !== undefined) this.unsupported("labeled break", stmt.loc);
        {
          const target = this.loopTargets.at(-1);
          if (target === undefined) this.unsupported("break outside a Rust-supported loop", stmt.loc);
          this.line(this.crossesCompletionBoundary(target)
            ? `return runtime::Completion::Break(${target.id});`
            : `break '${target.breakLabel};`);
        }
        return;
      case "continue":
        if (stmt.label !== undefined) this.unsupported("labeled continue", stmt.loc);
        {
          const target = this.loopTargets.at(-1);
          if (target === undefined) this.unsupported("continue outside a Rust-supported loop", stmt.loc);
          if (this.crossesCompletionBoundary(target)) {
            this.line(`return runtime::Completion::Continue(${target.id});`);
          } else {
            this.line(target.continueBlock === null
              ? `continue '${target.breakLabel};`
              : `break '${target.continueBlock};`);
          }
        }
        return;
      case "block":
        if ((stmt.labels?.length ?? 0) > 0) this.unsupported("labeled block", stmt.loc);
        this.line("{");
        this.indent += 1;
        this.emitStatements(stmt.body);
        this.indent -= 1;
        this.line("}");
        return;
      case "tryCatch":
        this.emitTryCatch(stmt);
        return;
      case "runtimeFence":
        // TypeScript lowering appends SC9002 after paths it proved cannot
        // fall through (for example, while(true) with a return). It remains
        // a loud invariant if frontend and backend ever disagree. Deferred
        // JavaScript fences need the future catchable-exception runtime.
        if (stmt.code !== "SC9002") this.unsupported(`runtime fence '${stmt.code}'`, stmt.loc);
        this.line(`panic!("${this.rustString(`${stmt.code}: ${stmt.message}`)}");`);
        return;
      default:
        this.unsupported(`statement '${stmt.kind}'`, stmt.loc);
    }
  }

  private emitTryCatch(stmt: Extract<IrStmt, { kind: "tryCatch" }>): void {
    const fn = this.currentFunction;
    if (fn === null) this.unsupported("try/catch outside a function", stmt.loc);
    let pending = `sc_rt_${this.temporary++}`;
    const payload = `sc_rt_${this.temporary++}`;
    this.line(`let ${pending} = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {`);
    this.indent += 1;
    this.completionLoopBoundaries.push(this.loopTargets.length);
    this.capturedReturnDepth += 1;
    this.emitStatements(stmt.tryBody);
    this.capturedReturnDepth -= 1;
    this.completionLoopBoundaries.pop();
    this.line(`runtime::Completion::<${this.rustType(fn.returnType, stmt.loc)}>::Normal`);
    this.indent -= 1;
    this.line("})) {");
    this.indent += 1;
    this.line("Ok(completion) => completion,");
    this.line(`Err(${payload}) => runtime::Completion::Throw(runtime::caught_from_panic(${payload})),`);
    this.indent -= 1;
    this.line("};");
    if (stmt.catchBody !== null) {
      const nextPending = `sc_rt_${this.temporary++}`;
      const caught = `sc_rt_${this.temporary++}`;
      const catchPayload = `sc_rt_${this.temporary++}`;
      this.line(`let ${nextPending} = match ${pending} {`);
      this.indent += 1;
      this.line(`runtime::Completion::Throw(${caught}) => {`);
      this.indent += 1;
      this.line("match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {");
      this.indent += 1;
      if (stmt.catchLocalId === null) {
        this.line(`let _ = ${caught};`);
      } else {
        const local = this.local(stmt.catchLocalId, stmt.loc);
        this.line(`let ${mangleLocal(local.id)}: runtime::Caught = ${caught};`);
      }
      this.completionLoopBoundaries.push(this.loopTargets.length);
      this.capturedReturnDepth += 1;
      this.emitStatements(stmt.catchBody);
      this.capturedReturnDepth -= 1;
      this.completionLoopBoundaries.pop();
      this.line(`runtime::Completion::<${this.rustType(fn.returnType, stmt.loc)}>::Normal`);
      this.indent -= 1;
      this.line("})) {");
      this.indent += 1;
      this.line("Ok(completion) => completion,");
      this.line(`Err(${catchPayload}) => runtime::Completion::Throw(runtime::caught_from_panic(${catchPayload})),`);
      this.indent -= 1;
      this.line("}");
      this.indent -= 1;
      this.line("},");
      this.line("completion => completion,");
      this.indent -= 1;
      this.line("};");
      pending = nextPending;
    }
    if (stmt.finallyBody !== null) {
      const finalResult = `sc_rt_${this.temporary++}`;
      const finalPayload = `sc_rt_${this.temporary++}`;
      this.line(`let ${finalResult} = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {`);
      this.indent += 1;
      this.completionLoopBoundaries.push(this.loopTargets.length);
      this.emitStatements(stmt.finallyBody);
      this.completionLoopBoundaries.pop();
      this.indent -= 1;
      this.line("}));");
      this.line(`if let Err(${finalPayload}) = ${finalResult} {`);
      this.indent += 1;
      this.line(`runtime::rethrow_caught(runtime::caught_from_panic(${finalPayload}));`);
      this.indent -= 1;
      this.line("}");
    }
    this.line(`match ${pending} {`);
    this.indent += 1;
    this.line("runtime::Completion::Normal => {},");
    this.line("runtime::Completion::Return(value) => {");
    this.indent += 1;
    this.line(this.capturedReturnDepth > 0
      ? "return runtime::Completion::Return(value);"
      : "return value;");
    this.indent -= 1;
    this.line("},");
    this.line("runtime::Completion::Throw(caught) => runtime::rethrow_caught(caught),");
    for (const target of this.loopTargets) {
      this.line(`runtime::Completion::Break(${target.id}) => break '${target.breakLabel},`);
      this.line(`runtime::Completion::Continue(${target.id}) => ${target.continueBlock === null
        ? `continue '${target.breakLabel}`
        : `break '${target.continueBlock}`},`);
    }
    this.line("runtime::Completion::Break(_) | runtime::Completion::Continue(_) => unreachable!(\"scriptc invariant: unknown completion target\"),");
    this.indent -= 1;
    this.line("}");
  }

  private emitExpr(expr: IrExpr): string {
    switch (expr.kind) {
      case "numLit":
        return this.numberLiteral(expr.value);
      case "strLit":
        return `runtime::string("${this.rustString(expr.value)}")`;
      case "boolLit":
        return expr.value ? "true" : "false";
      case "varRef":
        return this.emitRead(expr.localId, expr.type, expr.loc);
      case "bin":
        return this.emitBinary(expr);
      case "unary": {
        const operand = this.emitExpr(expr.operand);
        if (expr.op === "-") return `(-(${operand}))`;
        if (expr.op === "!") return `(!(${operand}))`;
        return `runtime::bit_not(${operand})`;
      }
      case "logical": {
        const temp = `sc_rt_${this.temporary++}`;
        const left = this.emitExpr(expr.left);
        const truthy = this.truthiness(temp, expr.left.type, expr.loc);
        const takeRight = expr.op === "&&" ? truthy : `!(${truthy})`;
        return `{ let ${temp} = ${left}; if ${takeRight} { ${this.emitExpr(expr.right)} } else { ${temp} } }`;
      }
      case "nullish": {
        if (expr.left.type.kind !== "union") this.unsupported("nullish over a non-union", expr.loc);
        const union = this.union(expr.left.type.unionId, expr.loc);
        const left = `sc_rt_${this.temporary++}`;
        const unitPatterns = union.arms.flatMap((arm, tag) =>
          this.isUnit(arm) ? [`${this.unionName(union.id)}::${this.unionVariant(tag)}`] : []
        );
        if (unitPatterns.length === 0) this.unsupported("nullish union without a unit arm", expr.loc);
        if (expr.type.kind === "union" && expr.type.unionId === union.id) {
          return `{ let ${left} = ${this.emitExpr(expr.left)}; if matches!(&${left}, ${unitPatterns.join(" | ")}) { ${this.emitExpr(expr.right)} } else { ${left} } }`;
        }
        const arms = union.arms.map((arm, tag) => {
          const variant = `${this.unionName(union.id)}::${this.unionVariant(tag)}`;
          return this.isUnit(arm)
            ? `${variant} => ${this.emitExpr(expr.right)}`
            : `${variant}(payload) => payload`;
        }).join(", ");
        return `{ let ${left} = ${this.emitExpr(expr.left)}; match ${left} { ${arms} } }`;
      }
      case "toBool": {
        const operand = this.emitExpr(expr.operand);
        const temp = `sc_rt_${this.temporary++}`;
        return `{ let ${temp} = ${operand}; ${this.truthiness(temp, expr.operand.type, expr.loc)} }`;
      }
      case "strConcat":
        return `runtime::string_concat(&(${this.emitExpr(expr.left)}), &(${this.emitExpr(expr.right)}))`;
      case "strIntrinsic":
        if (expr.method === "length") return `runtime::string_len(&(${this.emitExpr(expr.receiver)}))`;
        if (expr.method === "toLowerCase" && expr.args.length === 0) {
          return `runtime::string_to_lower_case(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "toUpperCase" && expr.args.length === 0) {
          return `runtime::string_to_upper_case(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "charAt" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_char_at(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if (expr.method === "charCodeAt" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_char_code_at(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if (expr.method === "repeat" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_repeat(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if ((expr.method === "indexOf" || expr.method === "includes") && expr.args[0] !== undefined) {
          const index = `runtime::string_index_of(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}), ${expr.args[1] === undefined ? "0.0" : this.emitExpr(expr.args[1])})`;
          return expr.method === "includes" ? `(${index} >= 0.0)` : index;
        }
        if (expr.method === "startsWith" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_starts_with(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}))`;
        }
        if (expr.method === "endsWith" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_ends_with(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}))`;
        }
        if (expr.method === "slice") {
          return `runtime::string_slice(&(${this.emitExpr(expr.receiver)}), ${expr.args[0] === undefined ? "0.0" : this.emitExpr(expr.args[0])}, ${expr.args[1] === undefined ? "f64::INFINITY" : this.emitExpr(expr.args[1])})`;
        }
        if (expr.method === "trim" && expr.args.length === 0) {
          return `runtime::string_trim(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "split" && expr.args.length === 2 && expr.args[0] !== undefined && expr.args[1] !== undefined) {
          return `runtime::string_split(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}), ${this.emitExpr(expr.args[1])})`;
        }
        this.unsupported(`string intrinsic '${expr.method}'`, expr.loc);
      case "strEq": {
        const compare = `(${this.emitExpr(expr.left)}).as_ref() == (${this.emitExpr(expr.right)}).as_ref()`;
        return expr.negated ? `!(${compare})` : `(${compare})`;
      }
      case "strCmp": {
        if (expr.utf16) this.unsupported("UTF-16 string comparison", expr.loc);
        return `((${this.emitExpr(expr.left)}).as_ref() ${expr.op} (${this.emitExpr(expr.right)}).as_ref())`;
      }
      case "toString": {
        const operand = this.emitExpr(expr.operand);
        if (expr.operand.type.kind === "f64") return `runtime::number_to_string(${operand})`;
        if (expr.operand.type.kind === "bool") return `runtime::bool_to_string(${operand})`;
        if (expr.operand.type.kind === "union") {
          const union = this.union(expr.operand.type.unionId, expr.loc);
          const name = this.unionName(union.id);
          const arms = union.arms.map((arm, tag) => {
            const variant = `${name}::${this.unionVariant(tag)}`;
            if (arm.kind === "undefinedT") return `${variant} => runtime::string("undefined")`;
            if (arm.kind === "nullT") return `${variant} => runtime::string("null")`;
            if (arm.kind === "string") return `${variant}(value) => value`;
            if (arm.kind === "f64") return `${variant}(value) => runtime::number_to_string(value)`;
            if (arm.kind === "bool") return `${variant}(value) => runtime::bool_to_string(value)`;
            this.unsupported(`toString union arm '${arm.kind}'`, expr.loc);
          }).join(", ");
          return `match ${operand} { ${arms} }`;
        }
        this.unsupported(`toString from '${expr.operand.type.kind}'`, expr.loc);
      }
      case "jsonStringify": {
        const value = this.emitExpr(expr.value);
        if (!this.isRustJsonCompatible(expr.value.type)) {
          this.unsupported(`JSON.stringify value '${expr.value.type.kind}'`, expr.loc);
        }
        const indent = (expr as typeof expr & { indent?: string }).indent;
        if (indent && expr.value.type.kind !== "f64" && expr.value.type.kind !== "bool" && expr.value.type.kind !== "string") {
          this.unsupported("JSON.stringify indentation for composite values", expr.loc);
        }
        return `runtime::json_stringify(&(${value}))`;
      }
      case "dynCheck": {
        if (expr.value.kind === "libCall" && expr.value.fn === "json.parse" && expr.value.args.length === 1) {
          const text = expr.value.args[0];
          if (text === undefined || text.type.kind !== "string" || !this.isRustJsonCompatible(expr.type)) {
            this.unsupported(`JSON.parse target '${expr.type.kind}'`, expr.loc);
          }
          return `runtime::json_parse_typed::<${this.rustType(expr.type, expr.loc)}>(&(${this.emitExpr(text)}))`;
        }
        this.unsupported("dynamic checked cast", expr.loc);
      }
      case "ternary":
        return `(if ${this.emitExpr(expr.cond)} { ${this.emitExpr(expr.then)} } else { ${this.emitExpr(expr.else_)} })`;
      case "arrayLit": {
        if (expr.type.kind !== "array") this.unsupported("array literal with a non-array type", expr.loc);
        const array = `sc_rt_${this.temporary++}`;
        const spreadSet = new Set(expr.spreads ?? []);
        const operations = expr.elems.map((element, index) => spreadSet.has(index)
          ? `runtime::array_extend(&${array}, &(${this.emitExpr(element)}));`
          : `runtime::array_push(&${array}, ${this.emitExpr(element)});`).join(" ");
        return `{ let ${array}: ${this.rustType(expr.type, expr.loc)} = runtime::array_new(Vec::new()); ${operations} ${array} }`;
      }
      case "arrayGet":
        if (expr.arr.type.kind !== "array") this.unsupported("arrayGet on a non-array", expr.loc);
        return `runtime::array_get(&(${this.emitExpr(expr.arr)}), ${this.emitExpr(expr.index)})`;
      case "arrIntrinsic":
        return this.emitArrayIntrinsic(expr);
      case "bytesNew": {
        if (expr.type.kind !== "bytes") this.unsupported("bytes construction result", expr.loc);
        const elem = this.rustBytesElement(expr.type.elem);
        if (expr.source === null) return `runtime::bytes_empty::<${elem}>()`;
        if (expr.source.type.kind === "f64") {
          return `runtime::bytes_alloc::<${elem}>(${this.emitExpr(expr.source)})`;
        }
        if (expr.source.type.kind === "bytes") {
          return `runtime::bytes_copy(&(${this.emitExpr(expr.source)}))`;
        }
        if (expr.source.type.kind === "array" && expr.source.type.elem.kind === "f64") {
          return `runtime::bytes_from_array::<${elem}>(&(${this.emitExpr(expr.source)}))`;
        }
        this.unsupported(`bytes construction from '${expr.source.type.kind}'`, expr.loc);
      }
      case "bytesIntrinsic": {
        if (expr.receiver.type.kind !== "bytes") this.unsupported("bytes intrinsic receiver", expr.loc);
        if (expr.method === "readNum" && expr.args.length === 2) {
          const kind = expr.args[0];
          const offset = expr.args[1];
          if (kind?.kind !== "strLit" || offset === undefined) this.unsupported("bytes readNum arguments", expr.loc);
          return `runtime::bytes_read_num(&(${this.emitExpr(expr.receiver)}), "${this.rustString(kind.value)}", ${this.emitExpr(offset)})`;
        }
        if (expr.method === "writeNum" && expr.args.length === 3) {
          const kind = expr.args[0];
          const value = expr.args[1];
          const offset = expr.args[2];
          if (kind?.kind !== "strLit" || value === undefined || offset === undefined) this.unsupported("bytes writeNum arguments", expr.loc);
          return `runtime::bytes_write_num(&(${this.emitExpr(expr.receiver)}), "${this.rustString(kind.value)}", ${this.emitExpr(value)}, ${this.emitExpr(offset)})`;
        }
        if (expr.method === "length" && expr.args.length === 0) {
          return `runtime::bytes_len(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "byteLength" && expr.args.length === 0) {
          return `runtime::bytes_byte_len(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "get" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::bytes_get(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if (expr.method === "slice" || expr.method === "subarray") {
          const start = expr.args[0] === undefined ? "0.0" : this.emitExpr(expr.args[0]);
          const end = expr.args[1] === undefined ? "f64::INFINITY" : this.emitExpr(expr.args[1]);
          return `runtime::bytes_slice(&(${this.emitExpr(expr.receiver)}), ${start}, ${end}, ${expr.method === "subarray"})`;
        }
        if (expr.method === "setFrom" && expr.args[0] !== undefined) {
          const offset = expr.args[1] === undefined ? "0.0" : this.emitExpr(expr.args[1]);
          return `runtime::bytes_set_from(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}), ${offset})`;
        }
        if (expr.method === "toString" && expr.args[0] !== undefined) {
          const encoding = this.emitExpr(expr.args[0]);
          if (expr.args.length === 1) {
            return `runtime::bytes_to_string(&(${this.emitExpr(expr.receiver)}), &(${encoding}))`;
          }
          const start = expr.args[1];
          const end = expr.args[2];
          if (start === undefined || expr.args.length > 3) this.unsupported("bytes toString arguments", expr.loc);
          return `runtime::bytes_to_string_range(&(${this.emitExpr(expr.receiver)}), &(${encoding}), ${this.emitExpr(start)}, ${end === undefined ? "f64::INFINITY" : this.emitExpr(end)})`;
        }
        this.unsupported(`bytes intrinsic '${expr.method}'`, expr.loc);
      }
      case "mapNew": {
        if (expr.type.kind !== "map") this.unsupported("mapNew with a non-map type", expr.loc);
        const type = expr.type;
        const map = `sc_rt_${this.temporary++}`;
        const equality = this.mapKeyEquality("left", "right", type.key, expr.loc);
        const entries = (expr.seed ?? []).map(({ key, value }) => {
          const keyTemp = `sc_rt_${this.temporary++}`;
          const valueTemp = `sc_rt_${this.temporary++}`;
          return `let ${keyTemp} = ${this.emitExpr(key)}; let ${valueTemp} = ${this.emitExpr(value)}; runtime::map_set_by(&${map}, ${this.mapStoredKey(keyTemp, type.key)}, ${valueTemp}, |left, right| ${equality});`;
        }).join(" ");
        return `{ let ${map}: ${this.rustType(expr.type, expr.loc)} = runtime::map_new(); ${entries} ${map} }`;
      }
      case "mapIntrinsic":
        return this.emitMapIntrinsic(expr);
      case "setNew": {
        if (expr.type.kind !== "set") this.unsupported("setNew with a non-set type", expr.loc);
        const equality = this.mapKeyEquality("left", "right", expr.type.elem, expr.loc);
        if (expr.seed === undefined) return `runtime::set_new::<${this.rustType(expr.type.elem, expr.loc)}>()`;
        const seed = `sc_rt_${this.temporary++}`;
        const value = "value";
        const normalized = this.mapStoredKey(value, expr.type.elem);
        return `{ let ${seed} = ${this.emitExpr(expr.seed)}; runtime::set_from_array_by(&${seed}, |${value}| ${normalized}, |left, right| ${equality}) }`;
      }
      case "setIntrinsic":
        return this.emitSetIntrinsic(expr);
      case "recordLit": {
        if (expr.type.kind !== "record") this.unsupported("record literal with a non-record type", expr.loc);
        const shape = this.records.get(expr.type.shapeId);
        if (shape === undefined) this.unsupported(`unknown record shape '${expr.type.shapeId}'`, expr.loc);
        const values = new Map<string, string>();
        const bindings: string[] = [];
        for (const entry of expr.fields) {
          if (entry.overflow || entry.drop) this.unsupported("record overflow/drop fields", expr.loc);
          const temp = `sc_rt_${this.temporary++}`;
          bindings.push(`let ${temp} = ${this.emitExpr(entry.value)};`);
          values.set(entry.name, temp);
        }
        const fields = shape.fields.map((field) => {
          const value = values.get(field.name);
          if (value === undefined) this.unsupported(`missing record field '${shape.id}.${field.name}'`, expr.loc);
          const stored = this.isEdgeValue(field.type) ? `Some(${value})` : value;
          return `${mangleField(field.name)}: ${stored}`;
        }).join(", ");
        return `{ ${bindings.join(" ")} runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields} }) }`;
      }
      case "recordGet": {
        const shape = this.records.get(expr.shapeId);
        const field = shape?.fields.find((candidate) => candidate.name === expr.field);
        if (shape === undefined || field === undefined) this.unsupported(`unknown record field '${expr.shapeId}.${expr.field}'`, expr.loc);
        const access = `record.${mangleField(field.name)}`;
        const result = this.isEdgeValue(field.type)
          ? `${access}.as_ref().expect("scriptc: cleared live record field").clone()`
          : this.needsClone(field.type) ? `${access}.clone()` : access;
        return `(${this.emitExpr(expr.obj)}).with(|record| ${result})`;
      }
      case "caughtTest":
        if (expr.test !== "instanceof" || expr.className === undefined || !RUNTIME_ERROR_CLASSES.has(expr.className)) {
          this.unsupported(`caught test '${expr.test}:${expr.className ?? ""}'`, expr.loc);
        }
        {
          const error = RUNTIME_ERROR_CLASSES.get(expr.className);
          if (error === undefined) this.unsupported(`caught test '${expr.test}:${expr.className}'`, expr.loc);
          const test = `runtime::caught_is_error_class(&(${this.emitExpr(expr.value)}), "${this.rustString(error.lib)}")`;
          return expr.negated ? `!(${test})` : test;
        }
      case "caughtNarrow":
        if (expr.type.kind !== "object" || !RUNTIME_ERROR_CLASSES.has(expr.type.className)) {
          this.unsupported("caught narrowing outside Error", expr.loc);
        }
        return `runtime::caught_error_value(&(${this.emitExpr(expr.value)}))`;
      case "caughtCheck": {
        if (expr.type.kind !== "object") this.unsupported("caught check outside an object", expr.loc);
        const error = RUNTIME_ERROR_CLASSES.get(expr.className);
        if (error === undefined) this.unsupported(`caught check '${expr.className}'`, expr.loc);
        return `runtime::caught_check_error(&(${this.emitExpr(expr.value)}), "${this.rustString(error.lib)}")`;
      }
      case "fieldGet":
        if (RUNTIME_ERROR_CLASSES.has(expr.className) && (expr.field === "name" || expr.field === "message")) {
          return `runtime::error_${expr.field}(&(${this.emitExpr(expr.obj)}))`;
        }
        {
          const cls = this.classDef(expr.className, expr.loc);
          const field = cls.fields.find((candidate) => candidate.name === expr.field);
          if (field === undefined) this.unsupported(`unknown class field '${expr.className}.${expr.field}'`, expr.loc);
          const access = `object.${this.classFieldName(expr.className, field.name, expr.loc)}`;
          const result = this.isEdgeValue(field.type)
            ? `${access}.as_ref().expect("scriptc: cleared live class field").clone()`
            : this.needsClone(field.type) ? `${access}.clone()` : access;
          return `(${this.emitExpr(expr.obj)}).with(|object| ${result})`;
        }
      case "unionWrap": {
        const union = this.union(expr.unionId, expr.loc);
        const arm = union.arms[expr.tag];
        if (arm === undefined) this.unsupported(`unknown union tag '${expr.unionId}:${expr.tag}'`, expr.loc);
        const variant = `${this.unionName(union.id)}::${this.unionVariant(expr.tag)}`;
        if (this.isUnit(arm)) return variant;
        return `${variant}(${this.emitExpr(expr.value)})`;
      }
      case "unionNarrow": {
        const union = this.union(expr.unionId, expr.loc);
        const arm = union.arms[expr.tag];
        if (arm === undefined || this.isUnit(arm)) this.unsupported(`invalid union narrow '${expr.unionId}:${expr.tag}'`, expr.loc);
        const value = `sc_rt_${this.temporary++}`;
        const variant = `${this.unionName(union.id)}::${this.unionVariant(expr.tag)}`;
        return `{ let ${value} = ${this.emitExpr(expr.value)}; match ${value} { ${variant}(payload) => payload, _ => unreachable!("scriptc invariant: invalid union narrowing") } }`;
      }
      case "unionDisc": {
        const union = this.union(expr.unionId, expr.loc);
        const value = `sc_rt_${this.temporary++}`;
        const arms = union.arms.map((arm, tag) => {
          if (arm.kind !== "record") this.unsupported(`union discriminant arm '${arm.kind}'`, expr.loc);
          const shape = this.records.get(arm.shapeId);
          const field = shape?.fields.find((candidate) => candidate.name === expr.field);
          if (shape === undefined || field === undefined) {
            this.unsupported(`unknown union discriminant field '${arm.shapeId}.${expr.field}'`, expr.loc);
          }
          const access = `record.${mangleField(field.name)}`;
          const result = this.isEdgeValue(field.type)
            ? `${access}.as_ref().expect("scriptc: cleared live union field").clone()`
            : this.needsClone(field.type) ? `${access}.clone()` : access;
          return `${this.unionName(union.id)}::${this.unionVariant(tag)}(payload) => payload.with(|record| ${result})`;
        }).join(", ");
        return `{ let ${value} = ${this.emitExpr(expr.value)}; match &${value} { ${arms} } }`;
      }
      case "unionIsTag": {
        const union = this.union(expr.unionId, expr.loc);
        const arm = union.arms[expr.tag];
        if (arm === undefined) this.unsupported(`unknown union tag '${expr.unionId}:${expr.tag}'`, expr.loc);
        const value = `sc_rt_${this.temporary++}`;
        const pattern = `${this.unionName(union.id)}::${this.unionVariant(expr.tag)}${this.isUnit(arm) ? "" : "(..)"}`;
        const test = `{ let ${value} = ${this.emitExpr(expr.value)}; matches!(${value}, ${pattern}) }`;
        return expr.negated ? `!(${test})` : test;
      }
      case "unionEq": {
        const union = this.union(expr.unionId, expr.loc);
        const left = `sc_rt_${this.temporary++}`;
        const right = `sc_rt_${this.temporary++}`;
        const test = `{ let ${left} = ${this.emitExpr(expr.left)}; let ${right} = ${this.emitExpr(expr.right)}; ${this.unionEqName(union.id)}(&${left}, &${right}, ${expr.sameValue}) }`;
        return expr.negated ? `!(${test})` : test;
      }
      case "closure":
        return this.emitClosure(expr);
      case "callValue":
        return this.emitCallValue(expr);
      case "selfRef": {
        if (this.currentFunction?.captures === undefined) {
          this.unsupported("selfRef outside a lifted closure", expr.loc);
        }
        return "sc_self.clone()";
      }
      case "call": {
        const callee = this.functions.get(expr.callee);
        if (callee === undefined) this.unsupported(`unknown call target '${expr.callee}'`, expr.loc);
        if (callee.captures !== undefined) this.unsupported(`direct call to lifted closure '${callee.name}'`, expr.loc);
        return `${mangleFunction(callee.name)}(${expr.args.map((arg) => this.emitExpr(arg)).join(", ")})`;
      }
      case "virtualCall": {
        const meta = this.classMetaOf(expr.className, expr.loc);
        const slot = meta.root.slots.find((candidate) =>
          candidate.method === expr.method && candidate.declarer.pre <= meta.pre && meta.pre <= candidate.declarer.post
        );
        if (slot === undefined) this.unsupported(`virtual method '${expr.className}.${expr.method}'`, expr.loc);
        const args = expr.args.map(() => `sc_rt_${this.temporary++}`);
        const bindings = expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`).join(" ");
        const receiver = args[0];
        if (receiver === undefined) this.unsupported(`virtual call '${expr.className}.${expr.method}' without receiver`, expr.loc);
        const pre = `sc_rt_${this.temporary++}`;
        const implementations = new Map<string, { fn: IrFunction; tags: number[] }>();
        for (const dynamic of this.classMeta.values()) {
          if (dynamic.def.abstract || dynamic.root !== meta.root || dynamic.pre < meta.pre || dynamic.pre > meta.post) continue;
          const implementation = this.virtualImplementation(dynamic, slot);
          const entry = implementations.get(implementation.name);
          if (entry === undefined) implementations.set(implementation.name, { fn: implementation, tags: [dynamic.pre] });
          else entry.tags.push(dynamic.pre);
        }
        const callArgs = args.join(", ");
        const arms = [...implementations.values()].map(({ fn, tags }) =>
          `${tags.join(" | ")} => ${mangleFunction(fn.name)}(${callArgs}),`
        ).join(" ");
        return `{ ${bindings} let ${pre} = ${receiver}.with(|object| object.sc_class_pre); match ${pre} { ${arms} _ => unreachable!("scriptc invariant: invalid dynamic class"), } }`;
      }
      case "instanceOf": {
        if (expr.value.type.kind !== "object") this.unsupported("instanceof on a non-object", expr.loc);
        const target = this.classMetaOf(expr.className, expr.loc);
        const value = `sc_rt_${this.temporary++}`;
        return `{ let ${value} = ${this.emitExpr(expr.value)}; ${value}.with(|object| ${target.pre} <= object.sc_class_pre && object.sc_class_pre <= ${target.post}) }`;
      }
      case "instanceOfValue": {
        if (expr.value.type.kind !== "object" || expr.classValue.type.kind !== "classval") {
          this.unsupported("dynamic instanceof operands", expr.loc);
        }
        const value = `sc_rt_${this.temporary++}`;
        const target = `sc_rt_${this.temporary++}`;
        const pre = `sc_rt_${this.temporary++}`;
        const staticTarget = this.classMetaOf(expr.classValue.type.className, expr.loc);
        const arms = this.classSubtree(staticTarget).map((candidate) =>
          `${candidate.pre} => ${candidate.pre} <= ${pre} && ${pre} <= ${candidate.post},`
        ).join(" ");
        return `{ let ${value} = ${this.emitExpr(expr.value)}; let ${target} = ${this.emitExpr(expr.classValue)}; let ${pre} = ${value}.with(|object| object.sc_class_pre); match ${target} { ${arms} _ => unreachable!("scriptc invariant: invalid class value"), } }`;
      }
      case "classRef":
        return String(this.classMetaOf(expr.className, expr.loc).pre);
      case "new": {
        const cls = this.classDef(expr.className, expr.loc);
        if (expr.type.kind !== "object" || expr.type.className !== cls.name) {
          this.unsupported(`constructor result for '${cls.name}'`, expr.loc);
        }
        const constructor = this.functions.get(`%${cls.name}.constructor`);
        if (constructor === undefined) this.unsupported(`missing constructor for '${cls.name}'`, expr.loc);
        const meta = this.classMetaOf(cls.name, expr.loc);
        const object = `sc_rt_${this.temporary++}`;
        const args = expr.args.map(() => `sc_rt_${this.temporary++}`);
        const shapeFields = meta.hierarchy
          ? this.hierarchyFields(meta.root)
          : cls.fields.map((field) => ({ owner: meta, field }));
        const fields = shapeFields.map(({ owner, field }) => {
          const value = this.isEdgeValue(field.type) ? "None" : this.defaultValue(field.type, cls.loc);
          return `${this.classFieldStorageName(owner, field.name)}: ${value}`;
        }).join(", ");
        const classTag = meta.hierarchy ? `sc_class_pre: ${meta.pre}, ` : "";
        const bindings = expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`).join(" ");
        return `{ let ${object} = runtime::Gc::new(${this.classStructName(cls.name, expr.loc)} { ${classTag}${fields} }); ${bindings} ${mangleFunction(constructor.name)}(${[`${object}.clone()`, ...args].join(", ")}); ${object} }`;
      }
      case "newValue": {
        if (expr.callee.type.kind !== "classval") this.unsupported("newValue with non-class callee", expr.loc);
        const staticMeta = this.classMetaOf(expr.callee.type.className, expr.loc);
        const callee = `sc_rt_${this.temporary++}`;
        const args = expr.args.map(() => `sc_rt_${this.temporary++}`);
        const bindings = [
          `let ${callee} = ${this.emitExpr(expr.callee)};`,
          ...expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`),
        ].join(" ");
        const arms = this.classSubtree(staticMeta).filter((dynamic) => !dynamic.def.abstract).map((dynamic) =>
          `${dynamic.pre} => ${this.classAllocation(dynamic, args, expr.loc)},`
        ).join(" ");
        return `{ ${bindings} match ${callee} { ${arms} _ => unreachable!("scriptc invariant: invalid class value"), } }`;
      }
      case "upcast":
      case "downcast":
        return this.emitExpr(expr.value);
      case "libCall": {
        const arg = expr.args[0];
        if (expr.fn === "math.floor" && expr.args.length === 1 && arg !== undefined) {
          return `(${this.emitExpr(arg)}).floor()`;
        }
        if (expr.fn === "process.argv" && expr.args.length === 0) return "runtime::process_argv()";
        if (expr.fn === "process.platform" && expr.args.length === 0) return "runtime::process_platform()";
        if (expr.fn === "process.cwd" && expr.args.length === 0) return "runtime::process_cwd()";
        if (expr.fn === "process.pid" && expr.args.length === 0) return "runtime::process_pid()";
        if (expr.fn === "process.getuid" && expr.args.length === 0) return "runtime::process_getuid()";
        if (expr.fn === "process.getgid" && expr.args.length === 0) return "runtime::process_getgid()";
        if (expr.fn === "process.execPath" && expr.args.length === 0) return "runtime::process_exec_path()";
        if (expr.fn === "process.arch" && expr.args.length === 0) return "runtime::process_arch()";
        if (expr.fn === "process.versionsNode" && expr.args.length === 0) return "runtime::process_versions_node()";
        if (expr.fn === "process.versionsOpenssl" && expr.args.length === 0) return "runtime::process_versions_openssl()";
        if (expr.fn === "process.envGet" && expr.args.length === 1 && arg !== undefined) {
          if (expr.type.kind !== "union") this.unsupported("process.envGet without an optional result union", expr.loc);
          const union = this.union(expr.type.unionId, expr.loc);
          const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
          const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
          if (stringTag < 0 || undefinedTag < 0) this.unsupported("process.envGet result union shape", expr.loc);
          const name = this.unionName(union.id);
          return `match runtime::process_env_get(&(${this.emitExpr(arg)})) { Some(value) => ${name}::${this.unionVariant(stringTag)}(value), None => ${name}::${this.unionVariant(undefinedTag)}, }`;
        }
        if (expr.fn === "num.parseInt" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::number_parse_int(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])})`;
        }
        if ((expr.fn === "num.isNaN" || expr.fn === "number.isNaN") && expr.args.length === 1 && arg !== undefined) {
          return `(${this.emitExpr(arg)}).is_nan()`;
        }
        if (expr.fn === "error.code" && expr.args.length === 1 && arg !== undefined) {
          if (expr.type.kind !== "union") this.unsupported("error.code without an optional result union", expr.loc);
          const union = this.union(expr.type.unionId, expr.loc);
          const stringTag = union.arms.findIndex((arm) => arm.kind === "string");
          const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
          if (stringTag < 0 || undefinedTag < 0) this.unsupported("error.code result union shape", expr.loc);
          const name = this.unionName(union.id);
          return `match runtime::error_code(&(${this.emitExpr(arg)})) { Some(value) => ${name}::${this.unionVariant(stringTag)}(value), None => ${name}::${this.unionVariant(undefinedTag)}, }`;
        }
        if (expr.fn === "fs.readFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          const path = `sc_rt_${this.temporary++}`;
          return `{ let ${path} = ${this.emitExpr(arg)}; let _ = ${this.emitExpr(expr.args[1])}; runtime::fs_read_file(&${path}) }`;
        }
        if ((expr.fn === "fs.readFileSyncBuf" || expr.fn === "fs.readFileSyncBytes") && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_read_file_bytes(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.readFdSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_read_fd(${this.emitExpr(arg)}, &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.readFdSyncBytes" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_read_fd_bytes(${this.emitExpr(arg)})`;
        }
        if (expr.fn === "fs.writeFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_write_file(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.writeFileSyncBytes" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_write_file_bytes(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.appendFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_append_file(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.existsSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_exists(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.mkdirSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_mkdir(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.rmSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_rm(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.rmdirSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_rmdir(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.readdirSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_readdir(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.realpathSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_realpath(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "os.tmpdir" && expr.args.length === 0) return "runtime::os_tmpdir()";
        if (expr.fn === "fs.mkdtempSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_mkdtemp(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.mkdirRecursiveSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_mkdir_recursive(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.rmOptsSync" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
          return `runtime::fs_rm_options(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])}, ${this.emitExpr(expr.args[2])})`;
        }
        if (expr.fn === "fs.rmRetrySync" && expr.args.length === 5 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
          const maxRetriesArg = expr.args[3];
          const retryDelayArg = expr.args[4];
          if (maxRetriesArg === undefined || retryDelayArg === undefined) this.unsupported("fs.rmRetrySync arguments", expr.loc);
          const path = `sc_rt_${this.temporary++}`;
          const recursive = `sc_rt_${this.temporary++}`;
          const force = `sc_rt_${this.temporary++}`;
          return `{ let ${path} = ${this.emitExpr(arg)}; let ${recursive} = ${this.emitExpr(expr.args[1])}; let ${force} = ${this.emitExpr(expr.args[2])}; let _ = ${this.emitExpr(maxRetriesArg)}; let _ = ${this.emitExpr(retryDelayArg)}; runtime::fs_rm_options(&${path}, ${recursive}, ${force}) }`;
        }
        if (expr.fn === "fs.unlinkSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_unlink(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "fs.copyFileSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_copy_file(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.renameSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_rename(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.chmodSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_chmod(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])})`;
        }
        if (expr.fn === "fs.chownSync" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
          return `runtime::fs_chown(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])}, ${this.emitExpr(expr.args[2])})`;
        }
        if (expr.fn === "fs.writeFileModeSync" && expr.args.length === 3 && arg !== undefined && expr.args[1] !== undefined && expr.args[2] !== undefined) {
          return `runtime::fs_write_file_mode(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}), ${this.emitExpr(expr.args[2])})`;
        }
        if ((expr.fn === "fs.mkdirModeSync" || expr.fn === "fs.mkdirRecursiveModeSync") && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_mkdir_mode(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])}, ${expr.fn === "fs.mkdirRecursiveModeSync"})`;
        }
        if (expr.fn === "fs.accessSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_access(&(${this.emitExpr(arg)}), ${this.emitExpr(expr.args[1])})`;
        }
        if (expr.fn === "fs.openSync" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::fs_open(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "fs.closeSync" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_close(${this.emitExpr(arg)})`;
        }
        if ((expr.fn === "fs.readSync" || expr.fn === "fs.writeSync") && expr.args.length === 5 && arg !== undefined) {
          const bytes = expr.args[1];
          const offset = expr.args[2];
          const length = expr.args[3];
          const position = expr.args[4];
          if (bytes === undefined || offset === undefined || length === undefined || position === undefined) {
            this.unsupported(`${expr.fn} arguments`, expr.loc);
          }
          const runtimeFn = expr.fn === "fs.readSync" ? "fs_read_sync" : "fs_write_sync";
          return `runtime::${runtimeFn}(${this.emitExpr(arg)}, &(${this.emitExpr(bytes)}), ${this.emitExpr(offset)}, ${this.emitExpr(length)}, ${this.emitExpr(position)})`;
        }
        if (expr.fn === "fs.writeStrSync" && expr.args.length === 4 && arg !== undefined) {
          const value = expr.args[1];
          const position = expr.args[2];
          const encoding = expr.args[3];
          if (value === undefined || position === undefined || encoding === undefined) this.unsupported("fs.writeStrSync arguments", expr.loc);
          return `runtime::fs_write_str_sync(${this.emitExpr(arg)}, &(${this.emitExpr(value)}), ${this.emitExpr(position)}, &(${this.emitExpr(encoding)}))`;
        }
        if (expr.fn === "buffer.fromStr" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::buffer_from_string(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "buffer.concat" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::buffer_concat(&(${this.emitExpr(arg)}))`;
        }
        if ((expr.fn === "fs.statSync" || expr.fn === "fs.lstatSync") && expr.args.length === 1 && arg !== undefined) {
          return `runtime::fs_stat(&(${this.emitExpr(arg)}), ${expr.fn === "fs.statSync"})`;
        }
        if (expr.fn === "stats.isFile" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_is_file(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.isDirectory" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_is_directory(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.isSymbolicLink" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_is_symlink(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.size" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_size(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.blocks" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_blocks(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.nlink" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_nlink(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.atimeMs" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_atime_ms(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "stats.mtimeMs" && expr.args.length === 1 && arg !== undefined) return `runtime::stats_mtime_ms(&(${this.emitExpr(arg)}))`;
        if (expr.fn === "path.join" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_join(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.resolve" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_resolve(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.normalize" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_normalize(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.dirname" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_dirname(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.extname" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_extname(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.isAbsolute" && expr.args.length === 1 && arg !== undefined) {
          return `runtime::path_is_absolute(&(${this.emitExpr(arg)}))`;
        }
        if (expr.fn === "path.toNamespacedPath" && expr.args.length === 1 && arg !== undefined) {
          return this.emitExpr(arg);
        }
        if (expr.fn === "path.basename" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::path_basename(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "path.relative" && expr.args.length === 2 && arg !== undefined && expr.args[1] !== undefined) {
          return `runtime::path_relative(&(${this.emitExpr(arg)}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if (expr.fn === "error.new" && expr.args.length === 1 && arg !== undefined && expr.type.kind === "object") {
          const error = RUNTIME_ERROR_CLASSES.get(expr.type.className);
          if (error === undefined) this.unsupported(`error.new result '${expr.type.className}'`, expr.loc);
          return `runtime::error_new("${this.rustString(error.lib)}", ${this.emitExpr(arg)})`;
        }
        if (expr.fn === "class.name" && expr.args.length === 1 && arg !== undefined && arg.type.kind === "classval") {
          const value = `sc_rt_${this.temporary++}`;
          const meta = this.classMetaOf(arg.type.className, expr.loc);
          const arms = this.classSubtree(meta).map((candidate) =>
            `${candidate.pre} => runtime::string("${this.rustString(candidate.def.jsName ?? "")}"),`
          ).join(" ");
          return `{ let ${value} = ${this.emitExpr(arg)}; match ${value} { ${arms} _ => unreachable!("scriptc invariant: invalid class value"), } }`;
        }
        this.unsupported(`library call '${expr.fn}'`, expr.loc);
      }
      case "intrinsic":
        if (expr.name !== "console.log" && expr.name !== "console.error") {
          this.unsupported(`intrinsic '${expr.name}'`, expr.loc);
        }
        return `runtime::${expr.name === "console.log" ? "console_log" : "console_error"}(&[${expr.args.map((arg) => this.displayExpr(arg)).join(", ")}])`;
      case "assignExpr": {
        const value = this.emitExpr(expr.value);
        const temp = `sc_rt_${this.temporary++}`;
        const clone = this.needsClone(expr.type) ? `${temp}.clone()` : temp;
        return `{ let ${temp} = ${value}; ${this.assignmentExpr(expr.localId, clone, expr.loc)} ${temp} }`;
      }
      case "seqExpr": {
        // Keep the straight-line statements inside the expression block.
        // Hoisting them into the surrounding Rust statement would run a
        // right-hand sequence before effects in the containing left side.
        const start = this.lines.length;
        const previousIndent = this.indent;
        this.indent = 0;
        this.emitStatements(expr.stmts);
        const result = this.emitExpr(expr.result);
        const statements = this.lines.splice(start).join(" ");
        this.indent = previousIndent;
        return `{ ${statements} ${result} }`;
      }
      case "incDec": {
        const old = `sc_rt_${this.temporary++}`;
        const next = `sc_rt_${this.temporary++}`;
        const read = this.emitRead(expr.localId, expr.type, expr.loc);
        const operation = expr.op === "+" ? "+" : "-";
        const result = expr.prefix ? next : old;
        return `{ let ${old} = ${read}; let ${next} = ${old} ${operation} 1.0; ${this.assignmentExpr(expr.localId, next, expr.loc)} ${result} }`;
      }
      case "fieldIncDec": {
        const cls = this.classDef(expr.className, expr.loc);
        const field = cls.fields.find((candidate) => candidate.name === expr.field);
        if (field === undefined) this.unsupported(`unknown class field '${expr.className}.${expr.field}'`, expr.loc);
        if (expr.fieldDyn || field.type.kind !== "f64") {
          this.unsupported(`increment/decrement of checked-dynamic class field '${expr.className}.${expr.field}'`, expr.loc);
        }
        const object = `sc_rt_${this.temporary++}`;
        const old = `sc_rt_${this.temporary++}`;
        const next = `sc_rt_${this.temporary++}`;
        const operation = expr.op === "+" ? "+" : "-";
        const result = expr.prefix ? next : old;
        const name = this.classFieldName(expr.className, field.name, expr.loc);
        return `{ let ${object} = ${this.emitExpr(expr.obj)}; ${object}.with_mut(|object| { let ${old} = object.${name}; let ${next} = ${old} ${operation} 1.0; object.${name} = ${next}; ${result} }) }`;
      }
      default:
        this.unsupported(`expression '${expr.kind}'`, expr.loc);
    }
  }

  private emitClosure(expr: Extract<IrExpr, { kind: "closure" }>): string {
    if (expr.type.kind !== "func") this.unsupported("closure with a non-function type", expr.loc);
    const shape = this.closureShapeForType(expr.type, expr.loc);
    const target = this.functions.get(expr.fnName);
    if (target === undefined || this.closureTargets.get(target.name) !== shape) {
      this.unsupported(`unknown closure target '${expr.fnName}'`, expr.loc);
    }
    const targetCaptures = target.captures ?? [];
    if (targetCaptures.length !== expr.captures.length) {
      this.unsupported(`capture arity for '${target.name}'`, expr.loc);
    }
    const variant = `${this.closureName(shape)}::${this.closureVariant(target)}`;
    let payload = variant;
    if (targetCaptures.length > 0) {
      const fields = targetCaptures.map((capture, index) => {
        const localId = expr.captures[index];
        if (localId === undefined) this.unsupported(`missing capture ${index} for '${target.name}'`, expr.loc);
        const local = this.local(localId, expr.loc);
        if (!local.boxed) this.unsupported(`unboxed capture '${local.name}'`, expr.loc);
        return `${this.captureField(index)}: Some(${mangleLocal(localId)}.clone())`;
      }).join(", ");
      payload = `${variant} { ${fields} }`;
    }
    const allocated = `runtime::Gc::new(${payload})`;
    if (target.captures !== undefined) return allocated;
    const slot = mangleFnClosure(target.name);
    const value = `sc_rt_${this.temporary++}`;
    return `${slot}.with(|slot| { let mut slot = slot.borrow_mut(); if let Some(value) = slot.as_ref() { value.clone() } else { let ${value} = ${allocated}; *slot = Some(${value}.clone()); ${value} } })`;
  }

  private emitCallValue(expr: Extract<IrExpr, { kind: "callValue" }>): string {
    if (expr.callee.type.kind !== "func") this.unsupported("callValue with a non-function callee", expr.loc);
    const shape = this.closureShapeForType(expr.callee.type, expr.loc);
    if (expr.args.length !== shape.type.params.length) {
      this.unsupported("callValue argument arity", expr.loc);
    }
    const callee = `sc_rt_${this.temporary++}`;
    const args = expr.args.map(() => `sc_rt_${this.temporary++}`);
    const bindings = [
      `let ${callee} = ${this.emitExpr(expr.callee)};`,
      ...expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`),
    ].join(" ");
    const arms = shape.targets.map((target) => {
      const captures = target.captures ?? [];
      const variant = `${this.closureName(shape)}::${this.closureVariant(target)}`;
      const fields = captures.map((_, index) => this.captureField(index));
      const pattern = fields.length === 0 ? variant : `${variant} { ${fields.join(", ")} }`;
      const callArgs: string[] = [];
      if (target.captures !== undefined) {
        callArgs.push(`${callee}.clone()`);
        callArgs.push(...fields.map((field) =>
          `${field}.as_ref().expect("scriptc: cleared live closure capture").clone()`,
        ));
      }
      callArgs.push(...args);
      return `${pattern} => ${mangleFunction(target.name)}(${callArgs.join(", ")})`;
    }).join(", ");
    return `{ ${bindings} ${callee}.with(|closure| match closure { ${arms} }) }`;
  }

  private emitBinary(expr: Extract<IrExpr, { kind: "bin" }>): string {
    const left = this.emitExpr(expr.left);
    const right = this.emitExpr(expr.right);
    if (this.isTracedHandle(expr.left.type) && (expr.op === "===" || expr.op === "!==")) {
      const compare = `((${left}).ptr_eq(&(${right})))`;
      return expr.op === "!==" ? `!(${compare})` : compare;
    }
    switch (expr.op) {
      case "+": case "-": case "*": case "/": case "%":
      case "<": case "<=": case ">": case ">=": case "===": case "!==":
        return `((${left}) ${expr.op === "===" ? "==" : expr.op === "!==" ? "!=" : expr.op} (${right}))`;
      case "**":
        return `(${left}).powf(${right})`;
      case "&":
        return `runtime::bit_and(${left}, ${right})`;
      case "|":
        return `runtime::bit_or(${left}, ${right})`;
      case "^":
        return `runtime::bit_xor(${left}, ${right})`;
      case "<<":
        return `runtime::shift_left(${left}, ${right})`;
      case ">>":
        return `runtime::shift_right(${left}, ${right})`;
      case ">>>":
        return `runtime::shift_right_unsigned(${left}, ${right})`;
    }
  }

  private displayExpr(expr: IrExpr): string {
    const emitted = this.emitExpr(expr);
    switch (expr.type.kind) {
      case "f64": return `runtime::display_number(${emitted})`;
      case "bool": return `runtime::display_bool(${emitted})`;
      case "string": return `runtime::display_string(&(${emitted}))`;
      default: this.unsupported(`console display type '${expr.type.kind}'`, expr.loc);
    }
  }

  private truthiness(value: string, type: IrType, loc: SrcLoc): string {
    switch (type.kind) {
      case "bool": return value;
      case "f64": return `(${value} != 0.0 && !${value}.is_nan())`;
      case "string": return `!${value}.is_empty()`;
      case "array": return "true";
      case "bytes": return "true";
      case "map": return "true";
      case "set": return "true";
      case "record": return "true";
      case "object": return "true";
      case "func": return "true";
      case "classval": return "true";
      default: this.unsupported(`truthiness for '${type.kind}'`, loc);
    }
  }

  private emitRead(id: string, type: IrType, loc: SrcLoc): string {
    const global = this.globals.get(id);
    if (global !== undefined) {
      const name = mangleGlobal(id);
      if (this.isHeapRoot(type)) {
        return `${name}.with(|slot| slot.borrow().as_ref().expect("scriptc: uninitialized global").clone())`;
      }
      if (this.needsClone(type)) return `${name}.with(|slot| slot.borrow().clone())`;
      if (type.kind === "f64" || type.kind === "bool" || type.kind === "classval") return `${name}.with(Cell::get)`;
      this.unsupported(`global read type '${type.kind}'`, loc);
    }
    const local = this.local(id, loc);
    if (local.boxed) {
      return local.tdz
        ? `runtime::cell_get_tdz(&${mangleLocal(id)}, "${this.rustString(local.name)}")`
        : `runtime::cell_get(&${mangleLocal(id)})`;
    }
    return this.needsClone(local.type) ? `${mangleLocal(id)}.clone()` : mangleLocal(id);
  }

  private emitAssignment(id: string, value: string, loc: SrcLoc): void {
    this.line(`${this.assignmentExpr(id, value, loc)}`);
  }

  private assignmentExpr(id: string, value: string, loc: SrcLoc): string {
    const global = this.globals.get(id);
    if (global !== undefined) {
      const name = mangleGlobal(id);
      if (this.isHeapRoot(global.type)) return `${name}.with(|slot| *slot.borrow_mut() = Some(${value}));`;
      if (this.needsClone(global.type)) return `${name}.with(|slot| *slot.borrow_mut() = ${value});`;
      if (global.type.kind === "f64" || global.type.kind === "bool" || global.type.kind === "classval") return `${name}.with(|slot| slot.set(${value}));`;
      this.unsupported(`global assignment type '${global.type.kind}'`, loc);
    }
    const local = this.local(id, loc);
    if (local.boxed) return `runtime::cell_set(&${mangleLocal(id)}, ${value});`;
    return `${mangleLocal(id)} = ${value};`;
  }

  private local(id: string, loc: SrcLoc) {
    const local = this.currentFunction?.locals.find((candidate) => candidate.id === id);
    if (local === undefined) this.unsupported(`unknown local '${id}'`, loc);
    return local;
  }

  private crossesCompletionBoundary(target: { id: number }): boolean {
    const boundary = this.completionLoopBoundaries.at(-1);
    if (boundary === undefined) return false;
    const index = this.loopTargets.findIndex((candidate) => candidate.id === target.id);
    return index >= 0 && index < boundary;
  }

  private rustBytesElement(elem: "u8" | "u32" | "i32" | "f32"): string {
    return elem;
  }

  private rustType(type: IrType, loc?: SrcLoc): string {
    switch (type.kind) {
      case "void": return "()";
      case "f64": return "f64";
      case "bool": return "bool";
      case "string": return "runtime::JsString";
      case "classval": {
        this.classMetaOf(type.className, loc);
        return "usize";
      }
      case "array": return `runtime::JsArray<${this.rustType(type.elem, loc)}>`;
      case "bytes": return `runtime::JsBytes<${this.rustBytesElement(type.elem)}>`;
      case "stats": return "runtime::JsStats";
      case "map": return `runtime::JsMap<${this.rustType(type.key, loc)}, ${this.rustType(type.value, loc)}>`;
      case "set": return `runtime::JsSet<${this.rustType(type.elem, loc)}>`;
      case "record": {
        const shape = this.records.get(type.shapeId);
        if (shape === undefined) this.unsupported(`unknown record type '${type.shapeId}'`, loc);
        if (shape.indexValue !== undefined) this.unsupported(`indexed record value '${type.shapeId}'`, loc);
        return `runtime::Gc<${mangleRecordStruct(type.shapeId)}>`;
      }
      case "object": {
        if (RUNTIME_ERROR_CLASSES.has(type.className)) return "runtime::JsError";
        if (!this.classes.has(type.className)) this.unsupported(`object type '${type.className}'`, loc);
        return `runtime::Gc<${this.classStructName(type.className, loc)}>`;
      }
      case "union": {
        if (!this.unions.has(type.unionId)) this.unsupported(`unknown union type '${type.unionId}'`, loc);
        return this.unionName(type.unionId);
      }
      case "func": {
        const shape = this.closureShapeForType(type, loc);
        return `runtime::Gc<${this.closureName(shape)}>`;
      }
      case "caught": return "runtime::Caught";
      default: this.unsupported(`type '${type.kind}'`, loc);
    }
  }

  private defaultValue(type: IrType, loc: SrcLoc): string {
    switch (type.kind) {
      case "f64": return "0.0";
      case "bool": return "false";
      case "string": return "runtime::empty_string()";
      case "array": return "runtime::array_new(Vec::new())";
      case "bytes": return `runtime::bytes_empty::<${this.rustBytesElement(type.elem)}>()`;
      case "map": return "runtime::map_new()";
      case "set": return "runtime::set_new()";
      case "classval": return "0";
      default: this.unsupported(`uninitialized '${type.kind}' local`, loc);
    }
  }

  private numberLiteral(value: number): string {
    if (Number.isNaN(value)) return "f64::NAN";
    if (value === Infinity) return "f64::INFINITY";
    if (value === -Infinity) return "f64::NEG_INFINITY";
    if (Object.is(value, -0)) return "-0.0_f64";
    const spelling = String(value).replace("e+", "e");
    return Number.isInteger(value) && !spelling.includes("e")
      ? `${spelling}.0_f64`
      : `${spelling}_f64`;
  }

  private emitArrayIntrinsic(expr: Extract<IrExpr, { kind: "arrIntrinsic" }>): string {
    if (expr.receiver.type.kind !== "array") this.unsupported("array intrinsic on a non-array", expr.loc);
    const receiver = `sc_rt_${this.temporary++}`;
    switch (expr.method) {
      case "length":
        return `runtime::array_len(&(${this.emitExpr(expr.receiver)}))`;
      case "pop":
        return `runtime::array_pop(&(${this.emitExpr(expr.receiver)}))`;
      case "indexOf":
      case "includes": {
        const needleExpr = expr.args[0];
        if (needleExpr === undefined) this.unsupported(`array ${expr.method} without a needle`, expr.loc);
        const needle = `sc_rt_${this.temporary++}`;
        const equality = this.arrayElementEquality("left", "right", expr.receiver.type.elem, expr.method === "includes", expr.loc);
        const helper = expr.method === "indexOf" ? "array_index_of_by" : "array_includes_by";
        return `{ let ${receiver} = ${this.emitExpr(expr.receiver)}; let ${needle} = ${this.emitExpr(needleExpr)}; runtime::${helper}(&${receiver}, &${needle}, |left, right| ${equality}) }`;
      }
      case "push": {
        const values = expr.args.map(() => `sc_rt_${this.temporary++}`);
        const bindings = expr.args.map((arg, index) => `let ${values[index]} = ${this.emitExpr(arg)};`).join(" ");
        const pushes = values.map((value) => `runtime::array_push(&${receiver}, ${value});`).join(" ");
        return `{ let ${receiver} = ${this.emitExpr(expr.receiver)}; ${bindings} ${pushes} runtime::array_len(&${receiver}) }`;
      }
      case "pushSpread": {
        const first = expr.args[0];
        if (first === undefined) this.unsupported("array pushSpread without a source", expr.loc);
        const source = `sc_rt_${this.temporary++}`;
        return `{ let ${receiver} = ${this.emitExpr(expr.receiver)}; let ${source} = ${this.emitExpr(first)}; runtime::array_extend(&${receiver}, &${source}) }`;
      }
      case "join": {
        const separator = expr.args[0];
        if (separator === undefined) this.unsupported("array join without a separator", expr.loc);
        const elem = expr.receiver.type.elem;
        if (elem.kind !== "f64" && elem.kind !== "bool" && elem.kind !== "string") {
          this.unsupported(`array join element '${elem.kind}'`, expr.loc);
        }
        return `runtime::array_join(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(separator)}))`;
      }
      default:
        this.unsupported(`array intrinsic '${expr.method}'`, expr.loc);
    }
  }

  private emitMapIntrinsic(expr: Extract<IrExpr, { kind: "mapIntrinsic" }>): string {
    if (expr.receiver.type.kind !== "map") this.unsupported("map intrinsic on a non-map", expr.loc);
    const type = expr.receiver.type;
    const receiver = `sc_rt_${this.temporary++}`;
    const receiverBinding = `let ${receiver} = ${this.emitExpr(expr.receiver)};`;
    if (expr.method === "size") return `{ ${receiverBinding} runtime::map_size(&${receiver}) }`;
    if (expr.method === "clear") return `{ ${receiverBinding} runtime::map_clear(&${receiver}) }`;
    if (expr.method === "iterCount") return `{ ${receiverBinding} runtime::map_iter_count(&${receiver}) }`;
    if (expr.method === "iterEnter") return `{ ${receiverBinding} runtime::map_iter_enter(&${receiver}) }`;
    if (expr.method === "iterExit") return `{ ${receiverBinding} runtime::map_iter_exit(&${receiver}) }`;
    if (expr.method === "iterLive" || expr.method === "iterKey" || expr.method === "iterValue") {
      const indexExpr = expr.args[0];
      if (indexExpr === undefined) this.unsupported(`map ${expr.method} without an index`, expr.loc);
      const index = `sc_rt_${this.temporary++}`;
      const helper = expr.method === "iterLive"
        ? "map_iter_live"
        : expr.method === "iterKey" ? "map_iter_key" : "map_iter_value";
      return `{ ${receiverBinding} let ${index} = ${this.emitExpr(indexExpr)}; runtime::${helper}(&${receiver}, ${index}) }`;
    }
    const keyExpr = expr.args[0];
    if (keyExpr === undefined) this.unsupported(`map ${expr.method} without a key`, expr.loc);
    const key = `sc_rt_${this.temporary++}`;
    const equality = this.mapKeyEquality("left", "right", type.key, expr.loc);
    const bindings = `${receiverBinding} let ${key} = ${this.emitExpr(keyExpr)};`;
    switch (expr.method) {
      case "set": {
        const valueExpr = expr.args[1];
        if (valueExpr === undefined) this.unsupported("map set without a value", expr.loc);
        const value = `sc_rt_${this.temporary++}`;
        return `{ ${bindings} let ${value} = ${this.emitExpr(valueExpr)}; runtime::map_set_by(&${receiver}, ${this.mapStoredKey(key, type.key)}, ${value}, |left, right| ${equality}) }`;
      }
      case "get": {
        if (expr.type.kind !== "union") this.unsupported("map get without an optional result union", expr.loc);
        const union = this.union(expr.type.unionId, expr.loc);
        const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
        if (undefinedTag < 0) this.unsupported("map get result union shape", expr.loc);
        const name = this.unionName(union.id);
        let present: string;
        if (type.value.kind === "union") {
          if (type.value.unionId === union.id) {
            present = "value";
          } else {
            const stored = this.union(type.value.unionId, expr.loc);
            const arms = stored.arms.map((arm, tag) => {
              const resultTag = union.arms.findIndex((candidate) => typeKey(candidate) === typeKey(arm));
              if (resultTag < 0) this.unsupported("map get union retag", expr.loc);
              const from = `${this.unionName(stored.id)}::${this.unionVariant(tag)}`;
              const to = `${name}::${this.unionVariant(resultTag)}`;
              return this.isUnit(arm) ? `${from} => ${to}` : `${from}(payload) => ${to}(payload)`;
            }).join(", ");
            present = `match value { ${arms} }`;
          }
        } else {
          const valueTag = union.arms.findIndex((arm) => typeKey(arm) === typeKey(type.value));
          if (valueTag < 0) this.unsupported("map get result union shape", expr.loc);
          present = `${name}::${this.unionVariant(valueTag)}(value)`;
        }
        return `{ ${bindings} match runtime::map_get_by(&${receiver}, &${key}, |left, right| ${equality}) { Some(value) => ${present}, None => ${name}::${this.unionVariant(undefinedTag)}, } }`;
      }
      case "has":
        return `{ ${bindings} runtime::map_has_by(&${receiver}, &${key}, |left, right| ${equality}) }`;
      case "delete":
        return `{ ${bindings} runtime::map_delete_by(&${receiver}, &${key}, |left, right| ${equality}) }`;
      default:
        this.unsupported(`map intrinsic '${expr.method}'`, expr.loc);
    }
  }

  private emitSetIntrinsic(expr: Extract<IrExpr, { kind: "setIntrinsic" }>): string {
    if (expr.receiver.type.kind !== "set") this.unsupported("set intrinsic on a non-set", expr.loc);
    const type = expr.receiver.type;
    const receiver = `sc_rt_${this.temporary++}`;
    const receiverBinding = `let ${receiver} = ${this.emitExpr(expr.receiver)};`;
    if (expr.method === "size") return `{ ${receiverBinding} runtime::map_size(&${receiver}) }`;
    if (expr.method === "clear") return `{ ${receiverBinding} runtime::map_clear(&${receiver}) }`;
    if (expr.method === "iterCount") return `{ ${receiverBinding} runtime::map_iter_count(&${receiver}) }`;
    if (expr.method === "iterEnter") return `{ ${receiverBinding} runtime::map_iter_enter(&${receiver}) }`;
    if (expr.method === "iterExit") return `{ ${receiverBinding} runtime::map_iter_exit(&${receiver}) }`;
    if (expr.method === "iterLive" || expr.method === "iterKey") {
      const indexExpr = expr.args[0];
      if (indexExpr === undefined) this.unsupported(`set ${expr.method} without an index`, expr.loc);
      const index = `sc_rt_${this.temporary++}`;
      const helper = expr.method === "iterLive" ? "map_iter_live" : "map_iter_key";
      return `{ ${receiverBinding} let ${index} = ${this.emitExpr(indexExpr)}; runtime::${helper}(&${receiver}, ${index}) }`;
    }
    const valueExpr = expr.args[0];
    if (valueExpr === undefined) this.unsupported(`set ${expr.method} without a value`, expr.loc);
    const value = `sc_rt_${this.temporary++}`;
    const equality = this.mapKeyEquality("left", "right", type.elem, expr.loc);
    const bindings = `${receiverBinding} let ${value} = ${this.emitExpr(valueExpr)};`;
    switch (expr.method) {
      case "add":
        return `{ ${bindings} runtime::set_add_by(&${receiver}, ${this.mapStoredKey(value, type.elem)}, |left, right| ${equality}) }`;
      case "has":
        return `{ ${bindings} runtime::set_has_by(&${receiver}, &${value}, |left, right| ${equality}) }`;
      case "delete":
        return `{ ${bindings} runtime::set_delete_by(&${receiver}, &${value}, |left, right| ${equality}) }`;
      default:
        this.unsupported(`set intrinsic '${expr.method}'`, expr.loc);
    }
  }

  private needsClone(type: IrType): boolean {
    return type.kind === "string" || type.kind === "union" || type.kind === "caught" || this.isTracedHandle(type);
  }

  private arrayElementEquality(left: string, right: string, type: IrType, sameValueZero: boolean, loc: SrcLoc): string {
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
      case "array":
      case "record":
      case "func":
        return `${left}.ptr_eq(${right})`;
      case "object":
        if (this.classes.has(type.className)) return `${left}.ptr_eq(${right})`;
        this.unsupported(`array identity for runtime object '${type.className}'`, loc);
      default:
        this.unsupported(`array ${sameValueZero ? "includes" : "indexOf"} element '${type.kind}'`, loc);
    }
  }

  private mapKeyEquality(left: string, right: string, type: IrType, loc: SrcLoc): string {
    if (type.kind === "f64") return `(*${left} == *${right} || (${left}.is_nan() && ${right}.is_nan()))`;
    if (type.kind === "string") return `${left}.as_ref() == ${right}.as_ref()`;
    this.unsupported(`map key '${type.kind}'`, loc);
  }

  private mapStoredKey(value: string, type: IrType): string {
    return type.kind === "f64" ? `if ${value} == 0.0 { 0.0 } else { ${value} }` : value;
  }

  private isTracedHandle(type: IrType): boolean {
    return type.kind === "array" || type.kind === "bytes" || type.kind === "map" || type.kind === "set" || type.kind === "stats" || type.kind === "record" ||
      (type.kind === "object" && this.classes.has(type.className)) || type.kind === "func";
  }

  private isEdgeValue(type: IrType): boolean {
    return this.isTracedHandle(type) || type.kind === "union";
  }

  private isHeapRoot(type: IrType): boolean {
    return this.isEdgeValue(type);
  }

  private isUnit(type: IrType): boolean {
    return type.kind === "undefinedT" || type.kind === "nullT";
  }

  private isRustJsonCompatible(type: IrType, visiting = new Set<string>()): boolean {
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
        const shape = this.records.get(type.shapeId);
        if (shape === undefined || shape.indexValue !== undefined) return false;
        const next = new Set(visiting).add(key);
        return shape.fields.every((field) => this.isRustJsonCompatible(field.type, next));
      }
      case "union": {
        const key = `union:${type.unionId}`;
        if (visiting.has(key)) return true;
        const union = this.unions.get(type.unionId);
        if (union === undefined) return false;
        const next = new Set(visiting).add(key);
        return union.arms.every((arm) => this.isRustJsonCompatible(arm, next));
      }
      default:
        return false;
    }
  }

  private ensureUnionArm(type: IrType): void {
    switch (type.kind) {
      case "f64":
      case "bool":
      case "string":
      case "array":
      case "record":
      case "object":
      case "classval":
      case "func":
      case "undefinedT":
      case "nullT":
        return;
      default:
        this.unsupported(`union arm '${type.kind}'`);
    }
  }

  private closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape {
    const shape = this.closureShapes.get(typeKey(type));
    if (shape === undefined) this.unsupported(`function signature '${typeKey(type)}' without closure targets`, loc);
    return shape;
  }

  private classDef(name: string, loc?: SrcLoc): IrClassDef {
    const cls = this.classes.get(name);
    if (cls === undefined) this.unsupported(`class '${name}'`, loc);
    return cls;
  }

  private classMetaOf(name: string, loc?: SrcLoc): RustClassMeta {
    const meta = this.classMeta.get(name);
    if (meta === undefined) this.unsupported(`class '${name}'`, loc);
    return meta;
  }

  private classStructName(name: string, loc?: SrcLoc): string {
    const meta = this.classMetaOf(name, loc);
    return mangleClassStruct(meta.hierarchy ? meta.root.def.name : name);
  }

  private hierarchyFields(root: RustClassMeta): { owner: RustClassMeta; field: IrClassDef["fields"][number] }[] {
    const fields: { owner: RustClassMeta; field: IrClassDef["fields"][number] }[] = [];
    const visit = (meta: RustClassMeta): void => {
      const inherited = meta.base?.def.fields.length ?? 0;
      for (const field of meta.def.fields.slice(inherited)) fields.push({ owner: meta, field });
      for (const child of meta.children) visit(child);
    };
    visit(root);
    return fields;
  }

  private classSubtree(meta: RustClassMeta): RustClassMeta[] {
    return [...this.classMeta.values()].filter((candidate) =>
      candidate.root === meta.root && meta.pre <= candidate.pre && candidate.pre <= meta.post
    );
  }

  private classAllocation(meta: RustClassMeta, args: readonly string[], loc: SrcLoc): string {
    const constructor = this.functions.get(`%${meta.def.name}.constructor`);
    if (constructor === undefined) this.unsupported(`missing constructor for '${meta.def.name}'`, loc);
    const object = `sc_rt_${this.temporary++}`;
    const shapeFields = meta.hierarchy
      ? this.hierarchyFields(meta.root)
      : meta.def.fields.map((field) => ({ owner: meta, field }));
    const fields = shapeFields.map(({ owner, field }) => {
      const value = this.isEdgeValue(field.type) ? "None" : this.defaultValue(field.type, meta.def.loc);
      return `${this.classFieldStorageName(owner, field.name)}: ${value}`;
    }).join(", ");
    const classTag = meta.hierarchy ? `sc_class_pre: ${meta.pre}, ` : "";
    return `{ let ${object} = runtime::Gc::new(${this.classStructName(meta.def.name, loc)} { ${classTag}${fields} }); ${mangleFunction(constructor.name)}(${[`${object}.clone()`, ...args].join(", ")}); ${object} }`;
  }

  private classFieldName(className: string, fieldName: string, loc?: SrcLoc): string {
    let owner = this.classMetaOf(className, loc);
    const index = owner.def.fields.findIndex((field) => field.name === fieldName);
    if (index < 0) this.unsupported(`unknown class field '${className}.${fieldName}'`, loc);
    while (owner.base !== null && index < owner.base.def.fields.length) owner = owner.base;
    return this.classFieldStorageName(owner, fieldName);
  }

  private classFieldStorageName(owner: RustClassMeta, fieldName: string): string {
    return owner.hierarchy ? `sc_hf_${owner.pre}_${mangleField(fieldName)}` : mangleField(fieldName);
  }

  private virtualImplementation(meta: RustClassMeta, slot: RustVtSlot): IrFunction {
    for (let current: RustClassMeta | null = meta; current !== null; current = current.base) {
      if (current.def.methods?.includes(slot.method) && !current.def.abstractMethods?.includes(slot.method)) {
        const fn = this.functions.get(`%${current.def.name}.${slot.method}`);
        if (fn === undefined) this.unsupported(`missing virtual implementation '${current.def.name}.${slot.method}'`, current.def.loc);
        return fn;
      }
    }
    this.unsupported(`missing virtual implementation '${meta.def.name}.${slot.method}'`, meta.def.loc);
  }

  private closureName(shape: RustClosureShape): string {
    return `sc_closure_${shape.index}`;
  }

  private closureVariant(target: IrFunction): string {
    const index = this.mod.functions.indexOf(target);
    if (index < 0) this.unsupported(`unknown closure function '${target.name}'`, target.loc);
    return `ScFn${index}`;
  }

  private captureField(index: number): string {
    return `sc_cap_${index}`;
  }

  private union(id: string, loc?: SrcLoc): IrUnionDef {
    const union = this.unions.get(id);
    if (union === undefined) this.unsupported(`unknown union '${id}'`, loc);
    return union;
  }

  private unionName(id: string): string {
    if (!/^[A-Za-z0-9_]+$/.test(id)) this.unsupported(`invalid union id '${id}'`);
    return `sc_u_${id}`;
  }

  private unionVariant(tag: number): string {
    return `ScArm${tag}`;
  }

  private unionEqName(id: string): string {
    return `sc_union_eq_${id}`;
  }

  private rustString(value: string): string {
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

  private line(value: string): void {
    this.lines.push(`${"    ".repeat(this.indent)}${value}`);
  }

  private unsupported(kind: string, loc?: SrcLoc): never {
    throw new RustUnsupportedError(kind, loc);
  }
}
