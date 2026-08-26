import type { IrExpr, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import type { IrFuncType, RustClosureShape } from "./model.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustReadableContext {
  readonly listenerShapes: ReadonlyMap<string, RustClosureShape>;
  readonly readableReadShapes: ReadonlyMap<string, RustClosureShape>;
  usesReadable(): boolean;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextTemporary(): string;
  emitExpr(expr: IrExpr): string;
  closureName(shape: RustClosureShape): string;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  sourceLoc(): SrcLoc;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit the module-specialized Readable object and its typed event bridge. */
export class RustReadableEmitter {
  constructor(private readonly context: RustReadableContext) {}

  emitTypeDefinition(): void {
    if (!this.context.usesReadable()) return;
    this.context.line("#[derive(Clone)]");
    this.context.line("enum ScReadableRead {");
    this.context.pushIndent();
    this.context.line("Never,");
    for (const shape of this.context.readableReadShapes.values()) {
      this.context.line(`${this.listenerVariant(shape)}(runtime::Gc<${this.context.closureName(shape)}>),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.line("impl runtime::Trace for ScReadableRead {");
    this.context.pushIndent();
    this.context.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
    this.context.pushIndent();
    this.context.line("match self {");
    this.context.pushIndent();
    this.context.line("Self::Never => {},");
    for (const shape of this.context.readableReadShapes.values()) {
      this.context.line(`Self::${this.listenerVariant(shape)}(callback) => tracer.edge(callback),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("type ScReadable = runtime::JsReadable<ScEmitterListener, ScReadableRead>;");
  }

  emitDefinitions(): void {
    if (!this.context.usesReadable()) return;
    const loc = this.context.sourceLoc();
    const byteArms: string[] = [];
    const voidArms: string[] = [];
    const readArms: string[] = [];
    for (const shape of this.context.listenerShapes.values()) {
      if (shape.type.rest === true) continue;
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "bytes") {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_chunk.clone()"], loc);
        byteArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
      if (shape.type.params.length === 0) {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, [], loc);
        voidArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
    }
    for (const shape of this.context.readableReadShapes.values()) {
      if (shape.type.rest === true || shape.type.params.length !== 1 ||
        shape.type.params[0]?.kind !== "object" || shape.type.params[0].className !== "%Readable") continue;
      const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_readable.clone()"], loc);
      readArms.push(`ScReadableRead::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
    }
    byteArms.push("_ => unreachable!(\"scriptc invariant: Readable data listener signature\"),");
    voidArms.push("_ => unreachable!(\"scriptc invariant: Readable lifecycle listener signature\"),");
    readArms.push("ScReadableRead::Never => {},");
    readArms.push("_ => unreachable!(\"scriptc invariant: Readable read callback signature\"),");
    this.context.line("fn sc_readable_emit_data(sc_readable: &ScReadable, sc_chunk: runtime::JsBytes<u8>) {");
    this.context.pushIndent();
    this.context.line("let sc_emitter = runtime::readable_emitter(sc_readable);");
    this.context.line("let sc_name = runtime::string(\"data\");");
    this.context.line("let sc_snapshot = runtime::emitter_snapshot(&sc_emitter, &sc_name);");
    this.context.line("for sc_registration in sc_snapshot { if !runtime::emitter_listener_should_invoke(&sc_registration) { continue; } if sc_registration.once { let _ = runtime::emitter_remove_registration(&sc_emitter, &sc_name, sc_registration.registration); } match sc_registration.callback {");
    this.context.pushIndent();
    for (const arm of byteArms) this.context.line(arm);
    this.context.popIndent();
    this.context.line("} }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_readable_emit_void(sc_readable: &ScReadable, sc_event: &str) {");
    this.context.pushIndent();
    this.context.line("let sc_emitter = runtime::readable_emitter(sc_readable);");
    this.context.line("let sc_name = runtime::string(sc_event);");
    this.context.line("let sc_snapshot = runtime::emitter_snapshot(&sc_emitter, &sc_name);");
    this.context.line("for sc_registration in sc_snapshot { if !runtime::emitter_listener_should_invoke(&sc_registration) { continue; } if sc_registration.once { let _ = runtime::emitter_remove_registration(&sc_emitter, &sc_name, sc_registration.registration); } match sc_registration.callback {");
    this.context.pushIndent();
    for (const arm of voidArms) this.context.line(arm);
    this.context.popIndent();
    this.context.line("} }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_readable_call_read(sc_readable: &ScReadable) {");
    this.context.pushIndent();
    this.context.line("let Some(sc_callback) = runtime::readable_read_callback(sc_readable) else { return; };");
    this.context.line("match sc_callback {");
    this.context.pushIndent();
    for (const arm of readArms) this.context.line(arm);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_readable_drain(sc_readable: ScReadable) {");
    this.context.pushIndent();
    this.context.line("runtime::readable_begin_drain(&sc_readable);");
    this.context.line("if runtime::readable_take_resume(&sc_readable, false) { sc_readable_emit_void(&sc_readable, \"resume\"); }");
    this.context.line("loop {");
    this.context.pushIndent();
    this.context.line("if let Some(sc_chunk) = runtime::readable_pop(&sc_readable) { sc_readable_emit_data(&sc_readable, sc_chunk); if runtime::readable_take_resume(&sc_readable, true) { sc_readable_emit_void(&sc_readable, \"resume\"); } if !runtime::readable_is_flowing(&sc_readable) { break; } continue; }");
    this.context.line("if runtime::readable_take_push_after_eof(&sc_readable) { runtime::throw_error_code(\"stream.push() after EOF\".to_owned(), \"ERR_STREAM_PUSH_AFTER_EOF\"); }");
    this.context.line("if runtime::readable_take_end(&sc_readable) { sc_readable_emit_void(&sc_readable, \"end\"); sc_readable_emit_void(&sc_readable, \"close\"); break; }");
    this.context.line("sc_readable_call_read(&sc_readable);");
    this.context.line("if !runtime::readable_has_data_or_eof(&sc_readable) { break; }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("runtime::readable_end_drain(&sc_readable);");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_readable_schedule(sc_readable: &ScReadable) {");
    this.context.pushIndent();
    this.context.line("if runtime::readable_schedule(sc_readable) { let sc_readable = sc_readable.clone(); runtime::process_next_tick(Box::new(move || sc_readable_drain(sc_readable))); }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_readable_schedule_notification(sc_readable: &ScReadable) {");
    this.context.pushIndent();
    this.context.line("let sc_emitter = runtime::readable_emitter(sc_readable);");
    this.context.line("if runtime::emitter_listener_count(&sc_emitter, &runtime::string(\"readable\")) == 0.0 || !runtime::readable_schedule_notification(sc_readable) { return; }");
    this.context.line("let sc_readable = sc_readable.clone();");
    this.context.line("runtime::process_next_tick(Box::new(move || { runtime::readable_begin_notification(&sc_readable); sc_readable_emit_void(&sc_readable, \"readable\"); if runtime::readable_take_end(&sc_readable) { sc_readable_emit_void(&sc_readable, \"end\"); sc_readable_emit_void(&sc_readable, \"close\"); } }));");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("");
  }

  emitLibCall(expr: RustLibCallExpr): string | null {
    switch (expr.fn) {
      case "readable.new": return this.emitNew(expr);
      case "readable.push": return this.emitPush(expr, false);
      case "readable.pushStr": return this.emitPush(expr, true);
      case "readable.pushNull": return this.emitPushNull(expr);
      case "readable.read": return this.emitRead(expr);
      case "readable.unshift": return this.emitUnshift(expr);
      case "readable.pause": return this.emitPause(expr);
      case "readable.resume": return this.emitResume(expr);
      case "readable.isPaused": return this.emitIsPaused(expr);
      case "readable.flowing": return this.emitFlowing(expr);
      case "stream.prop": return this.emitProp(expr);
      case "stream.destroyErr": return this.emitDestroyError(expr);
      default: return null;
    }
  }

  private emitNew(expr: RustLibCallExpr): string {
    const [highWaterMark, objectMode, autoDestroy, flags, callback] = expr.args;
    if (highWaterMark?.type.kind !== "f64" || objectMode?.type.kind !== "bool" ||
      autoDestroy?.type.kind !== "bool" || flags?.type.kind !== "f64" ||
      callback?.type.kind !== "func" || expr.args.length !== 5 ||
      expr.type.kind !== "object" || expr.type.className !== "%Readable") {
      this.context.unsupported("Readable constructor shape", expr.loc);
    }
    const shape = this.context.readableReadShapes.get(typeKey(callback.type));
    if (shape === undefined) this.context.unsupported("unregistered Readable read callback", expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} let _ = (${values[1]}, ${values[2]}, ${values[3]}); runtime::readable_new(${values[0]}, ScReadableRead::${this.listenerVariant(shape)}(${values[4]})) }`;
  }

  private emitPush(expr: RustLibCallExpr, stringChunk: boolean): string {
    const [receiver, chunk] = expr.args;
    const expected = stringChunk ? "string" : "bytes";
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      chunk?.type.kind !== expected || expr.args.length !== 2 || expr.type.kind !== "bool") {
      this.context.unsupported(`Readable ${stringChunk ? "string " : ""}push shape`, expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const pushed = stringChunk
      ? `runtime::readable_push_string(&${values[0]}, &${values[1]})`
      : `runtime::readable_push(&${values[0]}, ${values[1]})`;
    return `{ ${this.bind(expr.args, values)} let sc_result = ${pushed}; sc_readable_schedule(&${values[0]}); sc_readable_schedule_notification(&${values[0]}); sc_result }`;
  }

  private emitPushNull(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      expr.args.length !== 1 || expr.type.kind !== "bool") {
      this.context.unsupported("Readable null push shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; let sc_result = runtime::readable_push_null(&${value}); sc_readable_schedule(&${value}); sc_readable_schedule_notification(&${value}); sc_result }`;
  }

  private emitRead(expr: RustLibCallExpr): string {
    const [receiver, size] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      size?.type.kind !== "f64" || expr.args.length !== 2 || expr.type.kind !== "union") {
      this.context.unsupported("Readable read shape", expr.loc);
    }
    const union = this.context.union(expr.type.unionId, expr.loc);
    const bytesTag = union.arms.findIndex((arm) => arm.kind === "bytes" && arm.elem === "u8");
    const nullTag = union.arms.findIndex((arm) => arm.kind === "nullT");
    if (bytesTag < 0 || nullTag < 0) this.context.unsupported("Readable read result union", expr.loc);
    const name = this.context.unionName(union.id);
    return `match runtime::readable_read(&(${this.context.emitExpr(receiver)}), ${this.context.emitExpr(size)}) { Some(value) => ${name}::${this.context.unionVariant(bytesTag)}(value), None => ${name}::${this.context.unionVariant(nullTag)}, }`;
  }

  private emitUnshift(expr: RustLibCallExpr): string {
    const [receiver, chunk] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      chunk?.type.kind !== "bytes" || chunk.type.elem !== "u8" || expr.args.length !== 2 ||
      expr.type.kind !== "void") {
      this.context.unsupported("Readable unshift shape", expr.loc);
    }
    return `runtime::readable_unshift(&(${this.context.emitExpr(receiver)}), ${this.context.emitExpr(chunk)})`;
  }

  private emitProp(expr: RustLibCallExpr): string {
    const [receiver, name] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      name?.type.kind !== "string" || expr.args.length !== 2 || expr.type.kind !== "f64") {
      this.context.unsupported("Readable numeric property shape", expr.loc);
    }
    return `runtime::readable_prop(&(${this.context.emitExpr(receiver)}), &(${this.context.emitExpr(name)}))`;
  }

  private emitPause(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      expr.args.length !== 1 || expr.type.kind !== "object" || expr.type.className !== "%Readable") {
      this.context.unsupported("Readable pause shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; if runtime::readable_pause(&${value}) { sc_readable_emit_void(&${value}, "pause"); } ${value} }`;
  }

  private emitResume(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      expr.args.length !== 1 || expr.type.kind !== "object" || expr.type.className !== "%Readable") {
      this.context.unsupported("Readable resume shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; runtime::readable_resume(&${value}); sc_readable_schedule(&${value}); ${value} }`;
  }

  private emitIsPaused(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      expr.args.length !== 1 || expr.type.kind !== "bool") {
      this.context.unsupported("Readable isPaused shape", expr.loc);
    }
    return `runtime::readable_is_paused(&(${this.context.emitExpr(receiver)}))`;
  }

  private emitDestroyError(expr: RustLibCallExpr): string {
    const [receiver, error] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      error?.type.kind !== "object" || expr.args.length !== 2 || expr.type.kind !== "object" ||
      expr.type.className !== "%Readable") {
      this.context.unsupported("Readable destroy(error) shape", expr.loc);
    }
    const receiverValue = this.context.nextTemporary();
    const errorValue = this.context.nextTemporary();
    return `{ let ${receiverValue} = ${this.context.emitExpr(receiver)}; let ${errorValue} = ${this.context.emitExpr(error)}; runtime::process_next_tick(Box::new(move || runtime::throw_value(${errorValue}))); ${receiverValue} }`;
  }

  private emitFlowing(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      expr.args.length !== 1 || expr.type.kind !== "union") {
      this.context.unsupported("Readable flowing property shape", expr.loc);
    }
    const union = this.context.union(expr.type.unionId, expr.loc);
    const boolTag = union.arms.findIndex((arm) => arm.kind === "bool");
    const nullTag = union.arms.findIndex((arm) => arm.kind === "nullT");
    if (boolTag < 0 || nullTag < 0) this.context.unsupported("Readable flowing union", expr.loc);
    const name = this.context.unionName(union.id);
    return `match runtime::readable_flowing(&(${this.context.emitExpr(receiver)})) { Some(value) => ${name}::${this.context.unionVariant(boolTag)}(value), None => ${name}::${this.context.unionVariant(nullTag)}, }`;
  }

  private bind(args: readonly IrExpr[], values: readonly string[]): string {
    return args.map((arg, index) => `let ${values[index]} = ${this.context.emitExpr(arg)};`).join(" ");
  }

  private listenerVariant(shape: RustClosureShape): string {
    return `Closure${shape.index}`;
  }
}
