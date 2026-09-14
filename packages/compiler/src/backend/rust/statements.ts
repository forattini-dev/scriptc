import { rustByteStoreValue } from "./byte-store.js";
import type { RustByteReadInput } from "./byte-projections.js";
import type { RustByteRegions } from "./byte-regions.js";
import type { RustLocalCells } from "./local-cells.js";
import type { RustIntegerLoops } from "./integer-loops.js";
import type { RustIndexRegionPlan } from "./index-regions.js";
import type { IrClassDef, IrExpr, IrFunction, IrRecordShape, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { RUNTIME_ERROR_CLASSES, typeKey } from "../../ir/ir.js";
import { mangleField, mangleLocal } from "../mangle.js";
import { RUST_RECORD_OVERFLOW } from "./record-layout.js";
import { isSharedRecord } from "./shared-records.js";

export interface RustLoopTarget {
  readonly id: number;
  readonly kind: "loop" | "switch" | "block";
  readonly labels: readonly string[] | undefined;
  readonly breakLabel: string;
  readonly continueBlock: string | null;
  readonly allowsContinue: boolean;
}

export interface RustStatementContext {
  readonly byteRegions: RustByteRegions;
  readonly localCells: RustLocalCells;
  readonly integerLoops: RustIntegerLoops;
  readonly loopTargets: RustLoopTarget[];
  readonly completionLoopBoundaries: number[];
  capturedReturnDepth(): number;
  adjustCapturedReturnDepth(delta: number): void;
  asyncProtectedReturnDepth(): number;
  currentAsyncResult(): string | null;
  currentFunction(): IrFunction | null;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextTemporary(): string;
  nextLabel(prefix: "sc_loop" | "sc_continue" | "sc_switch" | "sc_block"): string;
  nextLoopTargetId(): number;
  dynTypeName(): string;
  emitExpr(expr: IrExpr): string;
  borrowBytesReceiver(expr: IrExpr, later: readonly IrExpr[]): string | null;
  emitRead(id: string, type: IrType, loc: SrcLoc): string;
  emitAssignment(id: string, value: string, loc: SrcLoc): void;
  emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc): string;
  local(id: string, loc: SrcLoc): IrFunction["locals"][number];
  localIsBoxed(local: IrFunction["locals"][number]): boolean;
  forceBoxedLocal(id: string, forced: boolean): void;
  rustType(type: IrType, loc?: SrcLoc): string;
  record(shapeId: string): IrRecordShape | undefined;
  classDef(name: string, loc?: SrcLoc): IrClassDef;
  classFieldName(className: string, fieldName: string, loc?: SrcLoc): string;
  hasErrorClassRoots(): boolean;
  isEdgeValue(type: IrType): boolean;
  rustString(value: string): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export function emitRustStatements(
  statements: readonly IrStmt[],
  context: RustStatementContext,
): void {
  new RustStatementEmitter(context).emit(statements);
}

class RustStatementEmitter {
  private readonly predeclaredLocals = new Set<string>();
  private byteRegionDepth = 0;

  constructor(private readonly context: RustStatementContext) {}

  emit(statements: readonly IrStmt[]): void {
    let fresh: string | null = null;
    for (const statement of statements) {
      if (fresh !== null && statement.kind === "for" && this.context.byteRegions.canBorrow(statement, fresh)) {
        this.emitByteRegion(statement, fresh);
      } else this.emitStatement(statement);
      const allocated = this.context.byteRegions.fresh(statement, local => this.context.localIsBoxed(local));
      if (allocated !== null) fresh = allocated;
      else if (statement.kind !== "varDecl" || (statement.init?.kind !== "numLit" && statement.init?.kind !== "boolLit")) fresh = null;
    }
  }

  private emitByteRegion(statement: IrStmt, output: string): void {
    this.byteRegionDepth++;
    try { this.emitByteRegionBody(statement, output); } finally { this.byteRegionDepth--; }
  }

  private emitByteRegionBody(statement: IrStmt, output: string): void {
    const indices = this.byteRegionDepth === 1
      ? this.context.integerLoops.regions.plan(statement, local => this.context.localIsBoxed(local)) : null;
    const inputs = this.context.byteRegions.inputs(statement, output, local => this.context.localIsBoxed(local))
      .map(input => ({ ...input, optional: this.context.nextTemporary(), slice: this.context.nextTemporary() }));
    for (const input of inputs) {
      if (input.projection !== undefined) {
        const projection = input.projection, handle = this.context.nextTemporary();
        const condition = this.context.emitExpr({ ...projection, kind: "unionIsTag", negated: false, type: { kind: "bool" } });
        this.context.line(`let ${handle} = if ${condition} { Some(${this.context.emitExpr(projection)}) } else { None };`);
        this.context.line(`runtime::bytes_with_optional_read_slice(${handle}.as_ref(), |${input.optional}| {`);
      } else this.context.line(`runtime::bytes_with_read_slice(&${mangleLocal(input.localId)}, |${input.optional}| {`);
      this.context.pushIndent();
    }
    this.emitByteInputSelection(statement, output, indices, inputs);
    for (let i = inputs.length; i > 0; i--) {
      this.context.popIndent();
      this.context.line("});");
    }
  }

  private emitByteInputSelection(statement: IrStmt, output: string, indices: RustIndexRegionPlan | null,
    inputs: readonly (RustByteReadInput & { optional: string; slice: string })[]): void {
    if (inputs.length === 0 && indices === null) this.emitByteOutputRegion(statement, output);
    else {
      // Select storage once. Missing projections preserve the previous direct
      // input/integer fast path; at most three loop bodies, never 2^N.
      const pattern = inputs.map(input => `Some(${input.slice})`).join(", ");
      const values = inputs.map(input => input.optional).join(", ");
      const condition = inputs.length === 0 ? (indices?.guard() ?? "true")
        : `let (${pattern},) = (${values},)${indices === null ? "" : ` && (${indices.guard()})`}`;
      this.context.line(`if ${condition} {`);
      this.context.pushIndent();
      const restores = inputs.map(input => this.context.byteRegions.bindInput(input, input.slice));
      try { this.emitIndexedOutputRegion(statement, output, indices); }
      finally { for (const restore of restores.reverse()) restore(); }
      this.context.popIndent();
      this.context.line("} else {");
      this.context.pushIndent();
      const direct = inputs.filter(input => input.projection === undefined);
      if (direct.length !== inputs.length) this.emitByteInputSelection(statement, output, indices, direct);
      else this.emitByteOutputRegion(statement, output);
      this.context.popIndent();
      this.context.line("}");
    }
  }

  private emitIndexedOutputRegion(statement: IrStmt, output: string, plan: RustIndexRegionPlan | null): void {
    if (plan === null) { this.emitByteOutputRegion(statement, output); return; }
    for (const declaration of plan.declarations()) this.context.line(declaration);
    const restore = this.context.integerLoops.regions.bind(plan);
    try { this.emitByteOutputRegion(statement, output); } finally { restore(); }
  }

  private emitByteOutputRegion(statement: IrStmt, output: string): void {
    const slice = this.context.nextTemporary();
    this.context.line(`runtime::bytes_with_mut_slice(&${mangleLocal(output)}, |${slice}| {`);
    this.context.pushIndent();
    const restore = this.context.byteRegions.bind(output, slice);
    try { this.emitStatement(statement); } finally { restore(); }
    this.context.popIndent();
    this.context.line("});");
  }

  private emitIntegerByteRead(expr: IrExpr): string | null {
    if (expr.kind !== "bytesIntrinsic" || expr.method !== "get" || expr.args.length !== 1 ||
      expr.args[0] === undefined || expr.receiver.type.kind !== "bytes" || expr.receiver.type.elem !== "u8") return null;
    const slice = this.context.byteRegions.read(expr.receiver) ?? this.context.byteRegions.read(expr.receiver, true);
    const index = this.context.integerLoops.index(expr.args[0]);
    return slice === null || index === undefined ? null
      : `runtime::bytes_region_get_u8_integer(&*${slice}, ${index})`;
  }

  private emitStatement(stmt: IrStmt): void {
    switch (stmt.kind) {
      case "varDecl": {
        const local = this.context.local(stmt.localId, stmt.loc);
        if (this.predeclaredLocals.has(local.id)) {
          if (stmt.init !== null) {
            this.context.emitAssignment(local.id, this.context.emitExpr(stmt.init), stmt.loc);
          }
          return;
        }
        // A declaration without an initializer can be assigned from inside
        // a generated catch_unwind closure (for example a destructuring
        // binding in Map iteration). Rust cannot prove that such a closure
        // initialized a plain local before a later read. JsCell represents
        // the JavaScript state directly: empty until the first assignment,
        // with the existing TDZ/read checks still guarding early access.
        if (stmt.init === null) {
          this.context.forceBoxedLocal(local.id, true);
        }
        if (this.context.localIsBoxed(local)) {
          this.context.line(this.context.localCells.declaration(local, this.context.rustType(local.type, stmt.loc),
            stmt.init === null ? null : this.context.emitExpr(stmt.init)));
          return;
        }
        const mutable = local.mutable ? "mut " : "";
        const indices = this.context.integerLoops.regions.current();
        const integer = indices?.read(local.id);
        if (indices !== undefined && integer !== undefined && stmt.init !== null) {
          const initial = indices.initializer(stmt.init, expr => this.context.emitExpr(expr), expr => this.emitIntegerByteRead(expr));
          if (initial === null) throw new Error("missing integer-region initializer proof");
          this.context.line(`let ${mutable}${integer}: i64 = ${initial};`);
          return;
        }
        const type = this.context.rustType(local.type, stmt.loc);
        if (stmt.init === null) {
          this.context.line(`let ${mutable}${mangleLocal(local.id)}: ${type};`);
          return;
        }
        this.context.line(`let ${mutable}${mangleLocal(local.id)}: ${type} = ${this.context.emitExpr(stmt.init)};`);
        return;
      }
      case "assign":
        this.context.emitAssignment(stmt.localId, this.context.emitExpr(stmt.value), stmt.loc);
        return;
      case "exprStmt":
        this.context.line(`let _ = ${this.context.emitExpr(stmt.expr)};`);
        return;
      case "if":
        this.context.line(`if ${this.context.emitExpr(stmt.cond)} {`);
        this.context.pushIndent();
        this.emit(stmt.then);
        this.context.popIndent();
        if (stmt.else_ === null) {
          this.context.line("}");
        } else {
          this.context.line("} else {");
          this.context.pushIndent();
          this.emit(stmt.else_);
          this.context.popIndent();
          this.context.line("}");
        }
        return;
      case "while":
        this.emitWhile(stmt);
        return;
      case "doWhile":
        this.emitDoWhile(stmt);
        return;
      case "switch":
        this.emitSwitch(stmt);
        return;
      case "for":
        this.emitFor(stmt);
        return;
      case "forOf":
        this.emitForOf(stmt);
        return;
      case "arraySet": {
        if (stmt.arr.type.kind !== "array") this.context.unsupported("arraySet on a non-array", stmt.loc);
        const array = this.context.nextTemporary();
        const index = this.context.nextTemporary();
        const value = this.context.nextTemporary();
        this.context.line(`{ let ${array} = ${this.context.emitExpr(stmt.arr)}; let ${index} = ${this.context.emitExpr(stmt.index)}; let ${value} = ${this.context.emitExpr(stmt.value)}; runtime::array_set(&${array}, ${index}, ${value}); }`);
        return;
      }
      case "arraySetLength": {
        if (stmt.arr.type.kind !== "array") this.context.unsupported("arraySetLength on a non-array", stmt.loc);
        const array = this.context.nextTemporary();
        const length = this.context.nextTemporary();
        this.context.line(`{ let ${array} = ${this.context.emitExpr(stmt.arr)}; let ${length} = ${this.context.emitExpr(stmt.length)}; runtime::array_set_length(&${array}, ${length}); }`);
        return;
      }
      case "arraySetUndefined":
      case "arrayDelete": {
        if (stmt.arr.type.kind !== "array") this.context.unsupported(`${stmt.kind} on a non-array`, stmt.loc);
        const array = this.context.nextTemporary();
        const index = this.context.nextTemporary();
        const helper = stmt.kind === "arraySetUndefined" ? "array_set_undefined" : "array_delete";
        this.context.line(`{ let ${array} = ${this.context.emitExpr(stmt.arr)}; let ${index} = ${this.context.emitExpr(stmt.index)}; runtime::${helper}(&${array}, ${index}); }`);
        return;
      }
      case "bytesSet": {
        if (stmt.arr.type.kind !== "bytes") this.context.unsupported("bytesSet on non-bytes", stmt.loc);
        const storedValue = rustByteStoreValue(stmt.arr.type, stmt.value);
        const bytes = this.context.nextTemporary();
        const index = this.context.nextTemporary();
        const value = this.context.nextTemporary();
        const integer = this.context.integerLoops.index(stmt.index);
        const setter = integer === undefined ? "bytes_set" : "bytes_set_usize";
        const region = this.context.byteRegions.read(stmt.arr);
        if (region !== null) {
          const integerValue = stmt.arr.type.elem === "u8" && integer !== undefined
            ? this.context.integerLoops.regions.current()?.number(storedValue, expr => this.context.emitExpr(expr), expr => this.emitIntegerByteRead(expr))
              ?? this.emitIntegerByteRead(storedValue) : null;
          if (integerValue != null) {
            this.context.line(`{ let ${index} = ${integer}; let ${value} = ${integerValue}; runtime::bytes_region_set_u8_integer(&mut *${region}, ${index}, ${value}); }`);
            return;
          }
          const regionSetter = integer === undefined ? "bytes_region_set" : "bytes_region_set_usize";
          this.context.line(`{ let ${index} = ${integer ?? this.context.emitExpr(stmt.index)}; let ${value} = ${this.context.emitExpr(storedValue)}; runtime::${regionSetter}(&mut *${region}, ${index}, ${value}); }`);
          return;
        }
        const borrowed = this.context.borrowBytesReceiver(stmt.arr, [stmt.index, stmt.value]);
        const receiver = borrowed === null ? this.context.emitExpr(stmt.arr) : `&${borrowed}`;
        const argument = borrowed === null ? `&${bytes}` : bytes;
        this.context.line(`{ let ${bytes} = ${receiver}; let ${index} = ${integer ?? this.context.emitExpr(stmt.index)}; let ${value} = ${this.context.emitExpr(storedValue)}; runtime::${setter}(${argument}, ${index}, ${value}); }`);
        return;
      }
      case "recordKeySet":
        this.emitRecordKeySet(stmt);
        return;
      case "recordKeyDelete":
        this.emitRecordKeyDelete(stmt);
        return;
      case "recordSet":
        this.emitRecordSet(stmt);
        return;
      case "fieldSet":
        this.emitFieldSet(stmt);
        return;
      case "throw":
        this.context.line(`runtime::throw_value(${this.context.emitExpr(stmt.value)});`);
        return;
      case "rethrow":
        this.context.line(`runtime::rethrow_caught(${this.context.emitRead(stmt.localId, { kind: "caught" }, stmt.loc)});`);
        return;
      case "return":
        this.emitReturn(stmt);
        return;
      case "break":
        this.emitBreak(stmt);
        return;
      case "continue":
        this.emitContinue(stmt);
        return;
      case "block":
        if ((stmt.labels?.length ?? 0) === 0) {
          this.context.line("{");
          this.context.pushIndent();
          this.emit(stmt.body);
          this.context.popIndent();
          this.context.line("}");
          return;
        }
        {
          const blockLabel = this.context.nextLabel("sc_block");
          this.context.line(`'${blockLabel}: {`);
          this.context.pushIndent();
          this.context.loopTargets.push({
            id: this.context.nextLoopTargetId(),
            kind: "block",
            labels: stmt.labels,
            breakLabel: blockLabel,
            continueBlock: null,
            allowsContinue: false,
          });
          this.emit(stmt.body);
          this.context.loopTargets.pop();
          this.context.popIndent();
          this.context.line("}");
        }
        return;
      case "tryCatch":
        this.emitTryCatch(stmt);
        return;
      case "runtimeFence":
        this.emitRuntimeFence(stmt);
        return;
      default:
        {
          const exhaustive: never = stmt;
          void exhaustive;
        }
    }
  }

  private emitWhile(stmt: Extract<IrStmt, { kind: "while" }>): void {
    const loopLabel = this.context.nextLabel("sc_loop");
    this.context.line(`'${loopLabel}: while ${this.context.emitExpr(stmt.cond)} {`);
    this.context.pushIndent();
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(),
      kind: "loop",
      labels: stmt.labels,
      breakLabel: loopLabel,
      continueBlock: null,
      allowsContinue: true,
    });
    this.emit(stmt.body);
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
  }

  private emitDoWhile(stmt: Extract<IrStmt, { kind: "doWhile" }>): void {
    const loopLabel = this.context.nextLabel("sc_loop");
    const continueTarget = this.context.nextLabel("sc_continue");
    this.context.line(`'${loopLabel}: loop {`);
    this.context.pushIndent();
    this.context.line(`'${continueTarget}: {`);
    this.context.pushIndent();
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(),
      kind: "loop",
      labels: stmt.labels,
      breakLabel: loopLabel,
      continueBlock: continueTarget,
      allowsContinue: true,
    });
    this.emit(stmt.body);
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`if !(${this.context.emitExpr(stmt.cond)}) { break '${loopLabel}; }`);
    this.context.popIndent();
    this.context.line("}");
  }

  private emitFor(stmt: Extract<IrStmt, { kind: "for" }>): void {
    this.context.line("{");
    this.context.pushIndent();
    const integerLoop = this.context.integerLoops.match(stmt, local => this.context.localIsBoxed(local));
    const integer = integerLoop === null ? null : this.context.nextTemporary();
    if (integerLoop !== null && integer !== null) {
      this.context.line(`let mut ${integer}: usize = 0; // integer induction`);
      this.context.integerLoops.bind(integerLoop.localId, integer);
    } else if (stmt.init !== null) this.emitStatement(stmt.init);
    const loopLabel = this.context.nextLabel("sc_loop");
    const condition = integerLoop !== null && integer !== null
      ? `${integer} < runtime::bytes_len_usize(&(${this.context.borrowBytesReceiver(integerLoop.limitReceiver, []) ?? this.context.emitExpr(integerLoop.limitReceiver)}))`
      : stmt.cond === null ? "true" : this.context.emitExpr(stmt.cond);
    this.context.line(`'${loopLabel}: while ${condition} {`);
    this.context.pushIndent();
    const continueTarget = this.context.nextLabel("sc_continue");
    this.context.line(`'${continueTarget}: {`);
    this.context.pushIndent();
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(),
      kind: "loop",
      labels: stmt.labels,
      breakLabel: loopLabel,
      continueBlock: continueTarget,
      allowsContinue: true,
    });
    this.emit(stmt.body);
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
    if (stmt.init?.kind === "varDecl") {
      const initLocal = this.context.local(stmt.init.localId, stmt.loc);
      if (this.context.localIsBoxed(initLocal) && !this.context.localCells.isStack(initLocal.id)) {
        const name = mangleLocal(initLocal.id);
        this.context.line(`${name} = runtime::cell_new(runtime::cell_get(&${name}));`);
      }
    }
    const counted = this.context.integerLoops.regions.current()?.loops.get(stmt);
    if (counted !== undefined) this.context.line(`${this.context.integerLoops.read(counted)} += 1;`);
    else if (integer !== null) this.context.line(`${integer} += 1;`);
    else if (stmt.update !== null) this.emitStatement(stmt.update);
    if (integerLoop !== null) this.context.integerLoops.unbind(integerLoop.localId);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
  }

  private emitForOf(stmt: Extract<IrStmt, { kind: "forOf" }>): void {
    if (stmt.iterable.type.kind === "generator") {
      this.emitGeneratorForOf(stmt);
      return;
    }
    if (stmt.iterable.type.kind !== "array") this.context.unsupported("for-of over a non-array", stmt.loc);
    const local = this.context.local(stmt.localId, stmt.loc);
    const array = this.context.nextTemporary();
    const index = this.context.nextTemporary();
    const loopLabel = this.context.nextLabel("sc_loop");
    const continueTarget = this.context.nextLabel("sc_continue");
    this.context.line("{");
    this.context.pushIndent();
    this.context.line(`let ${array} = ${this.context.emitExpr(stmt.iterable)};`);
    this.context.line(`let mut ${index} = 0.0_f64;`);
    this.context.line(`'${loopLabel}: while ${index} < runtime::array_len(&${array}) {`);
    this.context.pushIndent();
    this.context.line(`'${continueTarget}: {`);
    this.context.pushIndent();
    this.context.line(this.context.localIsBoxed(local)
      ? this.context.localCells.declaration(local, this.context.rustType(local.type, stmt.loc), `runtime::array_get(&${array}, ${index})`)
      : `let ${mangleLocal(local.id)}: ${this.context.rustType(local.type, stmt.loc)} = runtime::array_get(&${array}, ${index});`);
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(),
      kind: "loop",
      labels: stmt.labels,
      breakLabel: loopLabel,
      continueBlock: continueTarget,
      allowsContinue: true,
    });
    this.emit(stmt.body);
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`${index} += 1.0_f64;`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
  }

  private emitGeneratorForOf(stmt: Extract<IrStmt, { kind: "forOf" }>): void {
    if (stmt.iterable.type.kind !== "generator") this.context.unsupported("generator for-of shape", stmt.loc);
    const type = stmt.iterable.type;
    const local = this.context.local(stmt.localId, stmt.loc);
    const generator = this.context.nextTemporary();
    const item = this.context.nextTemporary();
    const loopLabel = this.context.nextLabel("sc_loop");
    const continueTarget = this.context.nextLabel("sc_continue");
    const next = type.nextT.kind === "dyn" ? `${this.context.dynTypeName()}::Undefined`
      : type.nextT.kind === "undefinedT" || type.nextT.kind === "void" || type.nextT.kind === "nullT" ? "()"
      : this.context.unsupported("generator for-of with a required next value", stmt.loc);
    this.context.line("{");
    this.context.pushIndent();
    this.context.line(`let ${generator} = ${this.context.emitExpr(stmt.iterable)};`);
    this.context.line(`'${loopLabel}: loop {`);
    this.context.pushIndent();
    this.context.line(`let ${item} = match runtime::generator_next(&${generator}, ${next}) {`);
    this.context.pushIndent();
    this.context.line("runtime::GeneratorStep::Yielded(value) => value,");
    this.context.line(`runtime::GeneratorStep::Returned(_) => break '${loopLabel},`);
    this.context.popIndent();
    this.context.line("};");
    this.context.line(`'${continueTarget}: {`);
    this.context.pushIndent();
    this.context.line(this.context.localIsBoxed(local)
      ? this.context.localCells.declaration(local, this.context.rustType(local.type, stmt.loc), item)
      : `let ${mangleLocal(local.id)}: ${this.context.rustType(local.type, stmt.loc)} = ${item};`);
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(), kind: "loop", labels: stmt.labels,
      breakLabel: loopLabel, continueBlock: continueTarget, allowsContinue: true,
    });
    this.emit(stmt.body);
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
  }

  private emitRecordKeySet(stmt: Extract<IrStmt, { kind: "recordKeySet" }>): void {
    const shape = this.context.record(stmt.shapeId);
    if (shape === undefined) this.context.unsupported(`keyed write on unknown record '${stmt.shapeId}'`, stmt.loc);
    const indexValue = shape.indexValue ?? shape.fields[0]?.type;
    if (indexValue === undefined || (shape.indexValue === undefined &&
      (stmt.overflowOnly === true || !shape.fields.every((field) => typeKey(field.type) === typeKey(indexValue))))) {
      this.context.unsupported(`keyed write on non-indexed record '${stmt.shapeId}'`, stmt.loc);
    }
    if (stmt.key.type.kind !== "string" || typeKey(stmt.value.type) !== typeKey(indexValue)) {
      this.context.unsupported(`keyed write types for record '${stmt.shapeId}'`, stmt.loc);
    }
    const object = this.context.nextTemporary();
    const key = this.context.nextTemporary();
    const value = this.context.nextTemporary();
    const bindings = `let ${object} = ${this.context.emitExpr(stmt.obj)}; let ${key} = ${this.context.emitExpr(stmt.key)}; let ${value} = ${this.context.emitExpr(stmt.value)};`;
    if (shape.indexValue === undefined) {
      const declared = shape.fields.map((field, index) => {
        const stored = this.context.isEdgeValue(field.type) ? `Some(${value})` : value;
        if (isSharedRecord(shape)) return `${index === 0 ? "if" : "else if"} ${key}.as_ref() == "${this.context.rustString(field.name)}" { ${object}.set_${mangleField(field.name)}(${value}); }`;
        return `${index === 0 ? "if" : "else if"} ${key}.as_ref() == "${this.context.rustString(field.name)}" { ${object}.with_mut(|record| record.${mangleField(field.name)} = ${stored}); }`;
      }).join(" ");
      this.context.line(`{ ${bindings} ${declared} else { runtime::throw_type_error(format!("Cannot add property '{}' to a fixed-shape object", ${key})); } }`);
      return;
    }
    if (shape.fields.length === 0) {
      this.context.line(`{ ${bindings} runtime::map_set_by(&${object}, ${key}, ${value}, |left, right| left.as_ref() == right.as_ref()); }`);
      return;
    }
    const declared = (stmt.overflowOnly ? [] : shape.fields).map((field, index) => {
      const checked = indexValue.kind === "dyn"
        ? this.context.emitDynCheckValue(field.type, value, stmt.loc)
        : value;
      const stored = this.context.isEdgeValue(field.type) ? `Some(${checked})` : checked;
      if (isSharedRecord(shape)) return `${index === 0 ? "if" : "else if"} ${key}.as_ref() == "${this.context.rustString(field.name)}" { ${object}.set_${mangleField(field.name)}(${checked}); }`;
      return `${index === 0 ? "if" : "else if"} ${key}.as_ref() == "${this.context.rustString(field.name)}" { ${object}.with_mut(|record| record.${mangleField(field.name)} = ${stored}); }`;
    });
    const overflow = `${object}.with(|record| record.${RUST_RECORD_OVERFLOW}.as_ref().expect("scriptc: cleared live record overflow").clone())`;
    const setOverflow = isSharedRecord(shape) ? `${object}.set_key(${key}, ${value});`
      : `let overflow = ${overflow}; runtime::map_set_by(&overflow, ${key}, ${value}, |left, right| left.as_ref() == right.as_ref());`;
    const dispatch = declared.length === 0
      ? setOverflow
      : `${declared.join(" ")} else { ${setOverflow} }`;
    this.context.line(`{ ${bindings} ${dispatch} }`);
  }

  private emitRecordKeyDelete(stmt: Extract<IrStmt, { kind: "recordKeyDelete" }>): void {
    const shape = this.context.record(stmt.shapeId);
    if (shape?.indexValue === undefined || shape.fields.length !== 0 || stmt.key.type.kind !== "string") {
      this.context.unsupported(`keyed delete on non-indexed record '${stmt.shapeId}'`, stmt.loc);
    }
    const object = this.context.nextTemporary();
    const key = this.context.nextTemporary();
    this.context.line(`{ let ${object} = ${this.context.emitExpr(stmt.obj)}; let ${key} = ${this.context.emitExpr(stmt.key)}; let _ = runtime::map_delete_by(&${object}, &${key}, |left, right| left.as_ref() == right.as_ref()); }`);
  }

  private emitRecordSet(stmt: Extract<IrStmt, { kind: "recordSet" }>): void {
    const shape = this.context.record(stmt.shapeId);
    const field = shape?.fields.find((candidate) => candidate.name === stmt.field);
    if (shape === undefined || field === undefined) {
      this.context.unsupported(`unknown record field '${stmt.shapeId}.${stmt.field}'`, stmt.loc);
    }
    const object = this.context.nextTemporary();
    const value = this.context.nextTemporary();
    if (isSharedRecord(shape)) {
      this.context.line(`{ let ${object} = ${this.context.emitExpr(stmt.obj)}; let ${value} = ${this.context.emitExpr(stmt.value)}; ${object}.set_${mangleField(field.name)}(${value}); }`);
      return;
    }
    const stored = this.context.isEdgeValue(field.type) ? `Some(${value})` : value;
    this.context.line(`{ let ${object} = ${this.context.emitExpr(stmt.obj)}; let ${value} = ${this.context.emitExpr(stmt.value)}; ${object}.with_mut(|record| record.${mangleField(field.name)} = ${stored}); }`);
  }

  private emitFieldSet(stmt: Extract<IrStmt, { kind: "fieldSet" }>): void {
    if (RUNTIME_ERROR_CLASSES.has(stmt.className) && (stmt.field === "name" || stmt.field === "message")) {
      const object = this.context.nextTemporary();
      const value = this.context.nextTemporary();
      const helper = this.context.hasErrorClassRoots() ? `sc_error_set_${stmt.field}` : `runtime::error_set_${stmt.field}`;
      this.context.line(`{ let ${object} = ${this.context.emitExpr(stmt.obj)}; let ${value} = ${this.context.emitExpr(stmt.value)}; ${helper}(&${object}, ${value}); }`);
      return;
    }
    const cls = this.context.classDef(stmt.className, stmt.loc);
    const field = cls.fields.find((candidate) => candidate.name === stmt.field);
    if (field === undefined) {
      this.context.unsupported(`unknown class field '${stmt.className}.${stmt.field}'`, stmt.loc);
    }
    const name = this.context.classFieldName(stmt.className, field.name, stmt.loc);
    const object = this.context.nextTemporary();
    const value = this.context.nextTemporary();
    const stored = this.context.isEdgeValue(field.type) ? `Some(${value})` : value;
    this.context.line(`{ let ${object} = ${this.context.emitExpr(stmt.obj)}; let ${value} = ${this.context.emitExpr(stmt.value)}; ${object}.with_mut(|object| object.${name} = ${stored}); }`);
  }

  private emitReturn(stmt: Extract<IrStmt, { kind: "return" }>): void {
    const value = stmt.value === null ? "()" : this.context.emitExpr(stmt.value);
    if (this.context.capturedReturnDepth() > 0) {
      this.context.line(`return runtime::Completion::Return(${value});`);
      return;
    }
    if (this.context.asyncProtectedReturnDepth() > 0) {
      this.context.line(`return runtime::AsyncCompletion::Return(${value});`);
      return;
    }
    const asyncResult = this.context.currentAsyncResult();
    if (asyncResult !== null) {
      this.context.line(`let _ = runtime::promise_fulfill(&${asyncResult}, ${value});`);
      this.context.line("return;");
      return;
    }
    this.context.line(stmt.value === null ? "return;" : `return ${value};`);
  }

  private emitBreak(stmt: Extract<IrStmt, { kind: "break" }>): void {
    const label = stmt.label;
    const target = label === undefined
      ? this.context.loopTargets.findLast((candidate) => candidate.kind !== "block")
      : this.context.loopTargets.findLast((candidate) => candidate.labels?.includes(label) === true);
    if (target === undefined) this.context.unsupported("break outside a Rust-supported loop", stmt.loc);
    this.context.line(this.crossesCompletionBoundary(target)
      ? `return runtime::Completion::Break(${target.id});`
      : `break '${target.breakLabel};`);
  }

  private emitContinue(stmt: Extract<IrStmt, { kind: "continue" }>): void {
    const target = this.context.loopTargets.findLast((candidate) =>
      candidate.kind === "loop" && (stmt.label === undefined || candidate.labels?.includes(stmt.label) === true)
    );
    if (target === undefined) this.context.unsupported("continue outside a Rust-supported loop", stmt.loc);
    if (this.crossesCompletionBoundary(target)) {
      this.context.line(`return runtime::Completion::Continue(${target.id});`);
    } else {
      this.context.line(target.continueBlock === null
        ? `continue '${target.breakLabel};`
        : `break '${target.continueBlock};`);
    }
  }

  private crossesCompletionBoundary(target: RustLoopTarget): boolean {
    const boundary = this.context.completionLoopBoundaries.at(-1);
    if (boundary === undefined) return false;
    const index = this.context.loopTargets.findIndex((candidate) => candidate.id === target.id);
    return index >= 0 && index < boundary;
  }

  private emitTryCatch(stmt: Extract<IrStmt, { kind: "tryCatch" }>): void {
    const fn = this.context.currentFunction();
    if (fn === null) this.context.unsupported("try/catch outside a function", stmt.loc);
    let pending = this.context.nextTemporary();
    const payload = this.context.nextTemporary();
    this.context.line(`let ${pending} = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {`);
    this.context.pushIndent();
    this.context.completionLoopBoundaries.push(this.context.loopTargets.length);
    this.context.adjustCapturedReturnDepth(1);
    this.emit(stmt.tryBody);
    this.context.adjustCapturedReturnDepth(-1);
    this.context.completionLoopBoundaries.pop();
    this.context.line(`runtime::Completion::<${this.context.rustType(fn.returnType, stmt.loc)}>::Normal`);
    this.context.popIndent();
    this.context.line("})) {");
    this.context.pushIndent();
    this.context.line("Ok(completion) => completion,");
    this.context.line(`Err(${payload}) => runtime::Completion::Throw(runtime::caught_from_panic(${payload})),`);
    this.context.popIndent();
    this.context.line("};");
    if (stmt.catchBody !== null) pending = this.emitCatch(stmt, pending, fn.returnType);
    if (stmt.finallyBody !== null) this.emitFinally(stmt.finallyBody);
    this.emitPendingCompletion(pending);
  }

  private emitCatch(
    stmt: Extract<IrStmt, { kind: "tryCatch" }>,
    pending: string,
    returnType: IrType,
  ): string {
    const nextPending = this.context.nextTemporary();
    const caught = this.context.nextTemporary();
    const catchPayload = this.context.nextTemporary();
    this.context.line(`let ${nextPending} = match ${pending} {`);
    this.context.pushIndent();
    this.context.line(`runtime::Completion::Throw(${caught}) => {`);
    this.context.pushIndent();
    this.context.line("match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {");
    this.context.pushIndent();
    if (stmt.catchLocalId === null) {
      this.context.line(`let _ = ${caught};`);
    } else {
      const local = this.context.local(stmt.catchLocalId, stmt.loc);
      this.context.line(this.context.localIsBoxed(local)
        ? `let ${mangleLocal(local.id)}: runtime::JsCell<runtime::Caught> = runtime::cell_new(${caught});`
        : `let ${mangleLocal(local.id)}: runtime::Caught = ${caught};`);
    }
    this.context.completionLoopBoundaries.push(this.context.loopTargets.length);
    this.context.adjustCapturedReturnDepth(1);
    this.emit(stmt.catchBody ?? []);
    this.context.adjustCapturedReturnDepth(-1);
    this.context.completionLoopBoundaries.pop();
    this.context.line(`runtime::Completion::<${this.context.rustType(returnType, stmt.loc)}>::Normal`);
    this.context.popIndent();
    this.context.line("})) {");
    this.context.pushIndent();
    this.context.line("Ok(completion) => completion,");
    this.context.line(`Err(${catchPayload}) => runtime::Completion::Throw(runtime::caught_from_panic(${catchPayload})),`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("},");
    this.context.line("completion => completion,");
    this.context.popIndent();
    this.context.line("};");
    return nextPending;
  }

  private emitFinally(statements: readonly IrStmt[]): void {
    const finalResult = this.context.nextTemporary();
    const finalPayload = this.context.nextTemporary();
    this.context.line(`let ${finalResult} = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {`);
    this.context.pushIndent();
    this.context.completionLoopBoundaries.push(this.context.loopTargets.length);
    this.emit(statements);
    this.context.completionLoopBoundaries.pop();
    this.context.popIndent();
    this.context.line("}));");
    this.context.line(`if let Err(${finalPayload}) = ${finalResult} {`);
    this.context.pushIndent();
    this.context.line(`runtime::rethrow_caught(runtime::caught_from_panic(${finalPayload}));`);
    this.context.popIndent();
    this.context.line("}");
  }

  private emitPendingCompletion(pending: string): void {
    this.context.line(`match ${pending} {`);
    this.context.pushIndent();
    this.context.line("runtime::Completion::Normal => {},");
    this.context.line("runtime::Completion::Return(value) => {");
    this.context.pushIndent();
    if (this.context.capturedReturnDepth() > 0) {
      this.context.line("return runtime::Completion::Return(value);");
    } else if (this.context.asyncProtectedReturnDepth() > 0) {
      this.context.line("return runtime::AsyncCompletion::Return(value);");
    } else if (this.context.currentAsyncResult() !== null) {
      this.context.line(`let _ = runtime::promise_fulfill(&${this.context.currentAsyncResult()}, value);`);
      this.context.line("return;");
    } else {
      this.context.line("return value;");
    }
    this.context.popIndent();
    this.context.line("},");
    this.context.line("runtime::Completion::Throw(caught) => runtime::rethrow_caught(caught),");
    for (const target of this.context.loopTargets) {
      this.context.line(`runtime::Completion::Break(${target.id}) => break '${target.breakLabel},`);
      if (target.allowsContinue) {
        this.context.line(`runtime::Completion::Continue(${target.id}) => ${target.continueBlock === null
          ? `continue '${target.breakLabel}`
          : `break '${target.continueBlock}`},`);
      }
    }
    this.context.line("runtime::Completion::Break(_) | runtime::Completion::Continue(_) => unreachable!(\"scriptc invariant: unknown completion target\"),");
    this.context.popIndent();
    this.context.line("}");
  }

  private emitRuntimeFence(stmt: Extract<IrStmt, { kind: "runtimeFence" }>): void {
    if (stmt.code === "SC9002") {
      this.context.line(`panic!("${this.context.rustString(`${stmt.code}: ${stmt.message}`)}");`);
    } else {
      this.context.line(`runtime::throw_error_code("${this.context.rustString(stmt.message)}".to_owned(), "${this.context.rustString(stmt.code)}");`);
    }
  }

  private emitSwitch(stmt: Extract<IrStmt, { kind: "switch" }>): void {
    const kind = stmt.disc.type.kind;
    if (kind !== "f64" && kind !== "string" && kind !== "bool") {
      this.context.unsupported(`switch discriminant '${kind}'`, stmt.loc);
    }
    const disc = this.context.nextTemporary();
    const start = this.context.nextTemporary();
    const switchLabel = this.context.nextLabel("sc_switch");
    const defaultIndex = stmt.cases.findIndex((candidate) => candidate.test === null);
    const tests = stmt.cases.flatMap((candidate, index) => {
      if (candidate.test === null) return [];
      if (candidate.test.type.kind !== kind) {
        this.context.unsupported("switch case type mismatch", candidate.test.loc);
      }
      const test = this.context.nextTemporary();
      const equality = kind === "string"
        ? `${disc}.as_ref() == ${test}.as_ref()`
        : `${disc} == ${test}`;
      return [`{ let ${test} = ${this.context.emitExpr(candidate.test)}; if ${equality} { ${index}_i32 } else { `];
    });
    const miss = `${defaultIndex < 0 ? stmt.cases.length : defaultIndex}_i32`;
    this.context.line("{");
    this.context.pushIndent();
    this.context.line(`let ${disc} = ${this.context.emitExpr(stmt.disc)};`);
    this.context.line(`let ${start}: i32 = ${tests.join("")}${miss}${" } }".repeat(tests.length)};`);

    const locals = new Map<string, IrFunction["locals"][number]>();
    for (const candidate of stmt.cases) {
      for (const statement of candidate.body) {
        if (statement.kind !== "varDecl") continue;
        locals.set(statement.localId, this.context.local(statement.localId, statement.loc));
      }
    }
    for (const local of locals.values()) {
      this.predeclaredLocals.add(local.id);
      this.context.forceBoxedLocal(local.id, true);
      this.context.line(this.context.localCells.declaration(local, this.context.rustType(local.type, stmt.loc), null));
    }

    this.context.line(`'${switchLabel}: {`);
    this.context.pushIndent();
    this.context.loopTargets.push({
      id: this.context.nextLoopTargetId(),
      kind: "switch",
      labels: stmt.labels,
      breakLabel: switchLabel,
      continueBlock: null,
      allowsContinue: false,
    });
    stmt.cases.forEach((candidate, index) => {
      this.context.line(`if ${start} <= ${index}_i32 {`);
      this.context.pushIndent();
      this.emit(candidate.body);
      this.context.popIndent();
      this.context.line("}");
    });
    this.context.loopTargets.pop();
    this.context.popIndent();
    this.context.line("}");
    for (const local of locals.values()) {
      this.predeclaredLocals.delete(local.id);
      this.context.forceBoxedLocal(local.id, false);
    }
    this.context.popIndent();
    this.context.line("}");
  }
}
