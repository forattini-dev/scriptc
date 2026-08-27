import type { IrExpr, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import type { IrFuncType, RustClosureShape } from "./model.js";
import type { RustStreamModel } from "./stream-model.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustDuplexContext {
  readonly listenerShapes: ReadonlyMap<string, RustClosureShape>;
  readonly streams: RustStreamModel;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextTemporary(): string;
  emitExpr(expr: IrExpr): string;
  dynTypeName(): string;
  closureName(shape: RustClosureShape): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  sourceLoc(): SrcLoc;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit a Duplex as two independently-buffered halves sharing one registry. */
export class RustDuplexEmitter {
  constructor(private readonly context: RustDuplexContext) {}

  emitTypeDefinition(): void {
    if (!this.context.streams.usesDuplex) return;
    this.emitCallbackType("ScDuplexRead", this.context.streams.duplexReadShapes);
    this.emitCallbackType("ScDuplexWrite", this.context.streams.duplexWriteShapes);
    this.emitCallbackType("ScDuplexFinal", this.context.streams.duplexFinalShapes);
    this.emitCallbackType("ScDuplexDone", this.context.streams.duplexDoneShapes);
    this.context.line("type ScDuplexReadable = runtime::JsReadable<ScEmitterListener, ScDuplexRead>;");
    this.context.line("type ScDuplexWritable = runtime::JsWritable<ScEmitterListener, ScDuplexWrite, ScDuplexFinal, ScDuplexDone>;");
    this.context.line("type ScDuplex = runtime::JsDuplex<ScEmitterListener, ScDuplexRead, ScDuplexWrite, ScDuplexFinal, ScDuplexDone>;");
  }

  emitDefinitions(): void {
    if (!this.context.streams.usesDuplex) return;
    const loc = this.context.sourceLoc();
    this.emitEventHelpers(loc);
    this.emitReadableHelpers(loc);
    this.emitWritableHelpers(loc);
    this.context.line("");
  }

  emitLibCall(expr: RustLibCallExpr): string | null {
    const receiver = expr.args[0];
    const duplexReceiver = receiver?.type.kind === "object" && receiver.type.className === "%Duplex";
    switch (expr.fn) {
      case "duplex.new": return this.emitNew(expr);
      case "readable.pushStr": return duplexReceiver ? this.emitPushString(expr) : null;
      case "readable.pushNull": return duplexReceiver ? this.emitPushNull(expr) : null;
      case "readable.setEncoding": return duplexReceiver ? this.emitSetEncoding(expr) : null;
      case "writable.writeStr": return duplexReceiver ? this.emitWriteString(expr) : null;
      case "writable.end": return duplexReceiver ? this.emitEnd(expr) : null;
      case "stream.prop": return duplexReceiver ? this.emitProp(expr) : null;
      default: return null;
    }
  }

  private emitCallbackType(name: string, shapes: ReadonlyMap<string, RustClosureShape>): void {
    this.context.line("#[derive(Clone)]");
    this.context.line(`enum ${name} {`);
    this.context.pushIndent();
    this.context.line("Never,");
    for (const shape of shapes.values()) {
      this.context.line(`${this.variant(shape)}(runtime::Gc<${this.context.closureName(shape)}>),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`impl runtime::Trace for ${name} {`);
    this.context.pushIndent();
    this.context.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
    this.context.pushIndent();
    this.context.line("match self {");
    this.context.pushIndent();
    this.context.line("Self::Never => {},");
    for (const shape of shapes.values()) {
      this.context.line(`Self::${this.variant(shape)}(callback) => tracer.edge(callback),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
  }

  private emitEventHelpers(loc: SrcLoc): void {
    const byteArms: string[] = [];
    const stringArms: string[] = [];
    const voidArms: string[] = [];
    const errorArms: string[] = [];
    for (const shape of this.context.listenerShapes.values()) {
      if (shape.type.rest === true) continue;
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "bytes") {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_chunk.clone()"], loc);
        byteArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "dyn") {
        const chunk = `${this.context.dynTypeName()}::Buffer(sc_chunk.clone())`;
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, [chunk], loc);
        byteArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
        const text = `${this.context.dynTypeName()}::String(sc_chunk.clone())`;
        const stringDispatch = this.context.emitClosureDispatch("callback", shape.type, [text], loc);
        stringArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${stringDispatch}; },`);
      }
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "string") {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_chunk.clone()"], loc);
        stringArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
      if (shape.type.params.length === 0) {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, [], loc);
        byteArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
        stringArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
        voidArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "object" &&
        shape.type.params[0].className === "%Error") {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_error.clone()"], loc);
        errorArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
    }
    if (this.context.streams.usesStreamFinished) {
      voidArms.push("ScEmitterListener::RuntimeVoid(callback, _) => callback(),");
      errorArms.push("ScEmitterListener::RuntimeError(callback, _) => callback(sc_error.clone()),");
    }
    if (this.context.streams.usesStreamConsumers) {
      byteArms.push("ScEmitterListener::RuntimeData(callback, _) => callback(Some(sc_chunk.clone()), None),");
      stringArms.push("ScEmitterListener::RuntimeData(callback, _) => callback(None, Some(sc_chunk.clone())),");
    }
    byteArms.push("_ => unreachable!(\"scriptc invariant: Duplex data listener signature\"),");
    stringArms.push("_ => unreachable!(\"scriptc invariant: Duplex string data listener signature\"),");
    voidArms.push("_ => unreachable!(\"scriptc invariant: Duplex lifecycle listener signature\"),");
    errorArms.push("_ => unreachable!(\"scriptc invariant: Duplex error listener signature\"),");
    this.context.line("fn sc_duplex_emit_data(sc_duplex: &ScDuplex, sc_chunk: runtime::JsBytes<u8>) {");
    this.context.pushIndent();
    this.emitEventLoop("sc_duplex", "data", byteArms);
    this.context.line("runtime::readable_write_pipes(&runtime::duplex_readable(sc_duplex), sc_chunk);");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_duplex_emit_string(sc_duplex: &ScDuplex, sc_chunk: runtime::JsString) {");
    this.context.pushIndent();
    this.emitEventLoop("sc_duplex", "data", stringArms);
    this.context.line("runtime::readable_write_pipes(&runtime::duplex_readable(sc_duplex), runtime::buffer_from_string(&sc_chunk, &runtime::string(\"utf8\")));");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_duplex_emit_void(sc_duplex: &ScDuplex, sc_event: &str) {");
    this.context.pushIndent();
    this.emitEventLoop("sc_duplex", "sc_event", voidArms, true);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_duplex_emit_error(sc_duplex: &ScDuplex, sc_error: runtime::JsError) {");
    this.context.pushIndent();
    this.context.line("let sc_emitter = runtime::duplex_emitter(sc_duplex);");
    this.context.line("let sc_name = runtime::string(\"error\");");
    this.context.line("let sc_snapshot = runtime::emitter_snapshot(&sc_emitter, &sc_name);");
    this.context.line("if sc_snapshot.is_empty() { runtime::throw_value(sc_error); }");
    this.context.line("for sc_registration in sc_snapshot { if !runtime::emitter_listener_should_invoke(&sc_registration) { continue; } if sc_registration.once { let _ = runtime::emitter_remove_registration(&sc_emitter, &sc_name, sc_registration.registration); } match sc_registration.callback {");
    this.context.pushIndent();
    for (const arm of errorArms) this.context.line(arm);
    this.context.popIndent();
    this.context.line("} }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_duplex_destroy_pipeline(sc_duplex: &ScDuplex, sc_error: runtime::JsError) { let sc_readable = runtime::duplex_readable(sc_duplex); let sc_writable = runtime::duplex_writable(sc_duplex); let sc_readable_changed = runtime::readable_destroy(&sc_readable, Some(sc_error.clone())); let sc_writable_changed = runtime::writable_destroy(&sc_writable, Some(sc_error.clone())); if sc_readable_changed || sc_writable_changed { let sc_duplex = sc_duplex.clone(); runtime::process_next_tick(Box::new(move || { sc_duplex_emit_error(&sc_duplex, sc_error); sc_duplex_emit_void(&sc_duplex, \"close\"); })); } }");
  }

  private emitEventLoop(receiver: string, event: string, arms: readonly string[], dynamic = false): void {
    this.context.line(`let sc_emitter = runtime::duplex_emitter(${receiver});`);
    this.context.line(`let sc_name = runtime::string(${dynamic ? event : `"${event}"`});`);
    this.context.line("let sc_snapshot = runtime::emitter_snapshot(&sc_emitter, &sc_name);");
    this.context.line("for sc_registration in sc_snapshot { if !runtime::emitter_listener_should_invoke(&sc_registration) { continue; } if sc_registration.once { let _ = runtime::emitter_remove_registration(&sc_emitter, &sc_name, sc_registration.registration); } match sc_registration.callback {");
    this.context.pushIndent();
    for (const arm of arms) this.context.line(arm);
    this.context.popIndent();
    this.context.line("} }");
  }

  private emitReadableHelpers(loc: SrcLoc): void {
    const readArms: string[] = [];
    for (const shape of this.context.streams.duplexReadShapes.values()) {
      if (shape.type.rest === true || shape.type.params.length !== 1 ||
        shape.type.params[0]?.kind !== "object" || shape.type.params[0].className !== "%Duplex") continue;
      const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_duplex.clone()"], loc);
      readArms.push(`ScDuplexRead::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
    }
    readArms.push("ScDuplexRead::Never => {},");
    readArms.push("_ => unreachable!(\"scriptc invariant: Duplex read callback signature\"),");
    this.context.line("fn sc_duplex_call_read(sc_duplex: &ScDuplex, sc_readable: &ScDuplexReadable) {");
    this.context.pushIndent();
    this.context.line("let Some(sc_callback) = runtime::readable_read_callback(sc_readable) else { return; };");
    this.context.line(`match sc_callback { ${readArms.join(" ")} }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_duplex_read_drain(sc_duplex: ScDuplex) {");
    this.context.pushIndent();
    this.context.line("let sc_readable = runtime::duplex_readable(&sc_duplex);");
    this.context.line("runtime::readable_begin_drain(&sc_readable);");
    this.context.line("if runtime::readable_take_resume(&sc_readable, false) { sc_duplex_emit_void(&sc_duplex, \"resume\"); }");
    this.context.line("if let Some(sc_chunk) = runtime::readable_pop(&sc_readable) { match sc_chunk { runtime::ReadableChunk::Bytes(value) => sc_duplex_emit_data(&sc_duplex, value), runtime::ReadableChunk::String(value) => sc_duplex_emit_string(&sc_duplex, value), } if runtime::readable_take_resume(&sc_readable, true) { sc_duplex_emit_void(&sc_duplex, \"resume\"); } runtime::readable_end_drain(&sc_readable); sc_duplex_read_schedule(&sc_duplex); return; }");
    this.context.line("if runtime::readable_take_push_after_eof(&sc_readable) { runtime::throw_error_code(\"stream.push() after EOF\".to_owned(), \"ERR_STREAM_PUSH_AFTER_EOF\"); }");
    this.context.line("if runtime::readable_take_end(&sc_readable) { sc_duplex_emit_void(&sc_duplex, \"end\"); runtime::readable_end_pipes(&sc_readable); if runtime::duplex_take_close(&sc_duplex) { sc_duplex_emit_void(&sc_duplex, \"close\"); } runtime::readable_end_drain(&sc_readable); return; }");
    this.context.line("sc_duplex_call_read(&sc_duplex, &sc_readable);");
    this.context.line("runtime::readable_end_drain(&sc_readable);");
    this.context.line("if runtime::readable_has_data_or_eof(&sc_readable) { sc_duplex_read_schedule(&sc_duplex); }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_duplex_read_schedule(sc_duplex: &ScDuplex) { let sc_readable = runtime::duplex_readable(sc_duplex); if runtime::readable_schedule(&sc_readable) { let sc_duplex = sc_duplex.clone(); runtime::process_next_tick(Box::new(move || sc_duplex_read_drain(sc_duplex))); } }");
    this.context.line("fn sc_duplex_start_flowing(sc_duplex: &ScDuplex) { let sc_readable = runtime::duplex_readable(sc_duplex); runtime::readable_start_flowing(&sc_readable); sc_duplex_read_schedule(sc_duplex); }");
  }

  private emitWritableHelpers(loc: SrcLoc): void {
    const writeArms: string[] = [];
    for (const shape of this.context.streams.duplexWriteShapes.values()) {
      const completionType = this.completionType(shape.type, loc);
      const completionShape = this.context.closureShapeForType(completionType, loc);
      const params = completionType.params.map((_, index) => `sc_arg_${index}`);
      const errorType = completionType.params[0];
      const errorParam = params[0];
      if (errorType === undefined || errorParam === undefined) this.context.unsupported("Duplex completion error", loc);
      const completedError = this.errorOption(errorParam, errorType, loc);
      const ignored = params.length <= 1 ? "" : `let _ = (${params.slice(1).join(", ")});`;
      const completion = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_duplex = sc_duplex.clone(); let sc_done = sc_done.clone(); let sc_called = std::rc::Rc::new(std::cell::Cell::new(false)); move |${params.join(", ")}| { ${ignored} if sc_called.replace(true) { return; } if let Some(sc_error) = ${completedError} { sc_duplex_destroy_pipeline(&sc_duplex, sc_error); return; } let sc_writable = runtime::duplex_writable(&sc_duplex); runtime::writable_complete_write(&sc_writable, sc_length); sc_duplex_after_write(&sc_duplex, sc_done.clone()); } })), trace: Some(std::rc::Rc::new({ let sc_duplex = sc_duplex.clone(); let sc_done = sc_done.clone(); move |tracer| { tracer.edge(&sc_duplex); runtime::Trace::trace(&sc_done, tracer); } })) })`;
      const dispatch = this.context.emitClosureDispatch("callback", shape.type, [
        "sc_duplex.clone()", "sc_chunk.clone()", "runtime::string(\"buffer\")", completion,
      ], loc);
      writeArms.push(`ScDuplexWrite::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
    }
    writeArms.push("ScDuplexWrite::Never => { runtime::writable_complete_write(sc_writable, sc_length); sc_duplex_after_write(sc_duplex, sc_done); },");
    writeArms.push("_ => unreachable!(\"scriptc invariant: Duplex write callback signature\"),");
    this.context.line("fn sc_duplex_call_write(sc_duplex: &ScDuplex, sc_writable: &ScDuplexWritable, sc_chunk: runtime::JsBytes<u8>, sc_length: usize, sc_done: ScDuplexDone) {");
    this.context.pushIndent();
    this.context.line("let Some(sc_callback) = runtime::writable_write_callback(sc_writable) else { runtime::writable_complete_write(sc_writable, sc_length); sc_duplex_after_write(sc_duplex, sc_done); return; };");
    this.context.line(`match sc_callback { ${writeArms.join(" ")} }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_duplex_write_drain(sc_duplex: &ScDuplex) { let sc_writable = runtime::duplex_writable(sc_duplex); let Some((sc_chunk, sc_length, sc_done)) = runtime::writable_take_write(&sc_writable) else { return; }; sc_duplex_call_write(sc_duplex, &sc_writable, sc_chunk, sc_length, sc_done); }");
    this.context.line("fn sc_duplex_after_write(sc_duplex: &ScDuplex, sc_done: ScDuplexDone) { sc_duplex_write_drain(sc_duplex); let sc_writable = runtime::duplex_writable(sc_duplex); if runtime::writable_take_drain(&sc_writable) { sc_duplex_emit_void(sc_duplex, \"drain\"); runtime::writable_resume_sources(&sc_writable); } match sc_done { ScDuplexDone::Never => {}, _ => unreachable!(\"scriptc invariant: Duplex completion callback signature\"), } }");
  }

  private emitNew(expr: RustLibCallExpr): string {
    const [hwmRead, hwmWrite, autoDestroy, emitClose, allowHalfOpen, readableSide, writableSide, flagsExpr] = expr.args;
    if (hwmRead?.type.kind !== "f64" || hwmWrite?.type.kind !== "f64" || autoDestroy?.type.kind !== "bool" ||
      emitClose?.type.kind !== "bool" || allowHalfOpen?.type.kind !== "bool" || readableSide?.type.kind !== "bool" ||
      writableSide?.type.kind !== "bool" || flagsExpr?.kind !== "numLit" || expr.type.kind !== "object" ||
      expr.type.className !== "%Duplex") this.context.unsupported("Duplex constructor shape", expr.loc);
    const flags = flagsExpr.value;
    if ((flags & ~3) !== 0) this.context.unsupported("Duplex constructor callback set", expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    let callbackIndex = 8;
    let read = "Option::<ScDuplexRead>::None";
    let write = "Option::<ScDuplexWrite>::None";
    if ((flags & 1) !== 0) {
      const callback = expr.args[callbackIndex];
      if (callback?.type.kind !== "func") this.context.unsupported("Duplex read callback shape", expr.loc);
      const shape = this.context.streams.duplexReadShapes.get(typeKey(callback.type));
      if (shape === undefined) this.context.unsupported("unregistered Duplex read callback", expr.loc);
      read = `Some(ScDuplexRead::${this.variant(shape)}(${values[callbackIndex]}))`;
      callbackIndex += 1;
    }
    if ((flags & 2) !== 0) {
      const callback = expr.args[callbackIndex];
      if (callback?.type.kind !== "func") this.context.unsupported("Duplex write callback shape", expr.loc);
      const shape = this.context.streams.duplexWriteShapes.get(typeKey(callback.type));
      if (shape === undefined) this.context.unsupported("unregistered Duplex write callback", expr.loc);
      write = `Some(ScDuplexWrite::${this.variant(shape)}(${values[callbackIndex]}))`;
      callbackIndex += 1;
    }
    if (callbackIndex !== expr.args.length) this.context.unsupported("Duplex constructor arity", expr.loc);
    return `{ ${this.bind(expr.args, values)} let _ = (${values[5]}, ${values[6]}, ${values[7]}); let sc_emitter = runtime::emitter_new_shaped::<ScEmitterListener>(&["close", "error", "prefinish", "finish", "drain", "data", "end", "readable"]); let sc_readable = runtime::readable_new::<ScEmitterListener, ScDuplexRead>(${values[0]}, ${values[3]}, ${read}, Option::<ScDuplexRead>::None); runtime::readable_set_emitter(&sc_readable, sc_emitter.clone()); let sc_writable = runtime::writable_new::<ScEmitterListener, ScDuplexWrite, ScDuplexFinal, ScDuplexDone>(${values[1]}, ${values[2]}, ${values[3]}, ${write}, Option::<ScDuplexFinal>::None); runtime::writable_set_emitter(&sc_writable, sc_emitter); runtime::duplex_new(sc_readable, sc_writable, ${values[4]}) }`;
  }

  private emitPushString(expr: RustLibCallExpr): string {
    const [receiver, chunk] = expr.args;
    if (!this.isDuplex(receiver) || chunk?.type.kind !== "string" || expr.args.length !== 2 || expr.type.kind !== "bool") {
      this.context.unsupported("Duplex string push shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} let sc_readable = runtime::duplex_readable(&${values[0]}); let sc_result = runtime::readable_push_string(&sc_readable, &${values[1]}); sc_duplex_read_schedule(&${values[0]}); sc_result }`;
  }

  private emitSetEncoding(expr: RustLibCallExpr): string {
    const [receiver, encoding] = expr.args;
    if (!this.isDuplex(receiver) || encoding?.type.kind !== "string" || expr.args.length !== 2 ||
      expr.type.kind !== "object" || expr.type.className !== "%Duplex") {
      this.context.unsupported("Duplex setEncoding shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} runtime::readable_set_encoding(&runtime::duplex_readable(&${values[0]}), &${values[1]}); ${values[0]} }`;
  }

  private emitPushNull(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver === undefined || !this.isDuplex(receiver) || expr.args.length !== 1 || expr.type.kind !== "bool") {
      this.context.unsupported("Duplex null push shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; let sc_readable = runtime::duplex_readable(&${value}); let sc_result = runtime::readable_push_null(&sc_readable); sc_duplex_read_schedule(&${value}); sc_result }`;
  }

  private emitWriteString(expr: RustLibCallExpr): string {
    const [receiver, chunk] = expr.args;
    if (!this.isDuplex(receiver) || chunk?.type.kind !== "string" || expr.args.length !== 2 || expr.type.kind !== "bool") {
      this.context.unsupported("Duplex string write shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} let sc_writable = runtime::duplex_writable(&${values[0]}); let sc_chunk = runtime::buffer_from_string(&${values[1]}, &runtime::string("utf8")); let sc_result = runtime::writable_enqueue(&sc_writable, sc_chunk, ScDuplexDone::Never); sc_duplex_write_drain(&${values[0]}); sc_result }`;
  }

  private emitEnd(expr: RustLibCallExpr): string {
    const [receiver, flags] = expr.args;
    if (!this.isDuplex(receiver) || flags?.kind !== "numLit" || flags.value !== 0 || expr.args.length !== 2 ||
      expr.type.kind !== "object" || expr.type.className !== "%Duplex") {
      this.context.unsupported("Duplex end shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} let _ = ${values[1]}; let sc_writable = runtime::duplex_writable(&${values[0]}); runtime::writable_mark_ended(&sc_writable); if runtime::writable_take_prefinish(&sc_writable) { sc_duplex_emit_void(&${values[0]}, "prefinish"); } if runtime::writable_schedule_finish(&sc_writable) { let sc_duplex = ${values[0]}.clone(); runtime::process_next_tick(Box::new(move || { let sc_writable = runtime::duplex_writable(&sc_duplex); runtime::writable_mark_finished(&sc_writable); sc_duplex_emit_void(&sc_duplex, "finish"); if runtime::duplex_take_close(&sc_duplex) { sc_duplex_emit_void(&sc_duplex, "close"); } })); } ${values[0]} }`;
  }

  private emitProp(expr: RustLibCallExpr): string {
    const [receiver, name] = expr.args;
    if (!this.isDuplex(receiver) || name?.type.kind !== "string" || expr.args.length !== 2 ||
      (expr.type.kind !== "f64" && expr.type.kind !== "bool")) this.context.unsupported("Duplex property shape", expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    const result = expr.type.kind === "f64"
      ? `match ${values[1]}.as_ref() { "readableHighWaterMark" | "readableLength" => runtime::readable_prop(&runtime::duplex_readable(&${values[0]}), &${values[1]}), _ => runtime::writable_number_prop(&runtime::duplex_writable(&${values[0]}), &${values[1]}), }`
      : `match ${values[1]}.as_ref() { "allowHalfOpen" => runtime::duplex_allow_half_open(&${values[0]}), "readable" | "readableEnded" => runtime::readable_prop(&runtime::duplex_readable(&${values[0]}), &${values[1]}) != 0.0, _ => runtime::writable_bool_prop(&runtime::duplex_writable(&${values[0]}), &${values[1]}), }`;
    return `{ ${this.bind(expr.args, values)} ${result} }`;
  }

  private completionType(type: IrFuncType, loc: SrcLoc): IrFuncType {
    const completion = type.params.at(-1);
    if (completion?.kind !== "func") this.context.unsupported("Duplex completion callback shape", loc);
    return completion;
  }

  private errorOption(value: string, type: IrType, loc: SrcLoc): string {
    if (type.kind !== "union") this.context.unsupported("Duplex completion error union", loc);
    const union = this.context.union(type.unionId, loc);
    const name = this.context.unionName(union.id);
    const arms = union.arms.map((arm, tag) => {
      const variant = `${name}::${this.context.unionVariant(tag)}`;
      if (arm.kind === "object" && arm.className === "%Error") return `${variant}(sc_error) => Some(sc_error)`;
      if (arm.kind === "nullT" || arm.kind === "undefinedT") return `${variant} => None`;
      this.context.unsupported(`Duplex completion error arm '${arm.kind}'`, loc);
    });
    return `match ${value} { ${arms.join(", ")} }`;
  }

  private bind(args: readonly IrExpr[], values: readonly string[]): string {
    return args.map((arg, index) => `let ${values[index]} = ${this.context.emitExpr(arg)};`).join(" ");
  }

  private isDuplex(expr: IrExpr | undefined): boolean {
    return expr?.type.kind === "object" && expr.type.className === "%Duplex";
  }

  private variant(shape: RustClosureShape): string {
    return `Closure${shape.index}`;
  }
}
