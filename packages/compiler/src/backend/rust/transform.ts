import type { IrExpr, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import type { IrFuncType, RustClosureShape } from "./model.js";
import type { RustStreamModel } from "./stream-model.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustTransformContext {
  readonly listenerShapes: ReadonlyMap<string, RustClosureShape>;
  readonly streams: RustStreamModel;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextTemporary(): string;
  emitExpr(expr: IrExpr): string;
  dynFunctionVariant(shape: RustClosureShape): string;
  dynTypeName(): string;
  closureName(shape: RustClosureShape): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  sourceLoc(): SrcLoc;
  rustType(type: IrType, loc?: SrcLoc): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  runtimeStreamBase(name: string): "%Readable" | "%Writable" | "%Duplex" | "%Transform" | null;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit byte-mode Transform as a composed Duplex with typed callback bridges. */
export class RustTransformEmitter {
  constructor(private readonly context: RustTransformContext) {}

  emitTypeDefinition(): void {
    if (!this.context.streams.usesTransform) return;
    const subclass = this.context.streams.usesTransformSubclass;
    this.emitCallbackType("ScTransformRead", new Map(), ["Never"], null);
    this.emitCallbackType("ScTransformWrite", new Map(), ["Transform"], null);
    this.emitCallbackType("ScTransformFinal", new Map(), ["Flush"], null);
    this.emitCallbackType("ScTransformDone", this.context.streams.transformDoneShapes, ["Never"], null);
    this.emitCallbackType("ScTransformCallback", this.context.streams.transformCallbackShapes, ["Never"], subclass ? {
      variant: "RuntimeTransform",
      fields: "std::rc::Rc<dyn Fn(ScTransform, runtime::JsBytes<u8>, usize, ScTransformDone)>, std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>",
    } : null);
    this.emitCallbackType("ScTransformFlush", this.context.streams.transformFlushShapes, ["Never"], subclass ? {
      variant: "RuntimeFlush",
      fields: "std::rc::Rc<dyn Fn(ScTransform, std::rc::Rc<dyn Fn()>, std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>)>, std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>",
    } : null);
    this.context.line("type ScTransformDuplex = runtime::JsDuplex<ScEmitterListener, ScTransformRead, ScTransformWrite, ScTransformFinal, ScTransformDone>;");
    this.context.line("type ScTransform = runtime::JsTransform<ScEmitterListener, ScTransformRead, ScTransformWrite, ScTransformFinal, ScTransformDone, ScTransformCallback, ScTransformFlush>;");
  }

  emitDefinitions(): void {
    if (!this.context.streams.usesTransform) return;
    const loc = this.context.sourceLoc();
    this.emitEventHelpers(loc);
    this.emitReadableHelpers();
    this.emitWriteHelpers(loc);
    this.emitFlushHelpers(loc);
    this.context.line("");
  }

  emitLibCall(expr: RustLibCallExpr): string | null {
    if (expr.fn === "transform.new" || expr.fn === "passthrough.new") return this.emitNew(expr);
    if (expr.fn === "transform.init" || expr.fn === "passthrough.init") return this.emitInit(expr);
    const receiver = expr.args[0];
    if (!this.isTransform(receiver)) return null;
    switch (expr.fn) {
      case "readable.push": return this.emitPush(expr, false);
      case "readable.pushStr": return this.emitPush(expr, true);
      case "readable.pushNull": return this.emitPushNull(expr);
      case "readable.setEncoding": return this.emitSetEncoding(expr);
      case "readable.nextChunkDyn": return this.emitNextChunkDynamic(expr);
      case "writable.write": return this.emitWrite(expr, false);
      case "writable.writeStr": return this.emitWrite(expr, true);
      case "writable.end": return this.emitEnd(expr);
      case "writable.cork": return this.emitCork(expr);
      case "writable.uncork": return this.emitUncork(expr);
      case "stream.setTransform": return this.emitSetCallback(expr, true);
      case "stream.setFlush": return this.emitSetCallback(expr, false);
      case "stream.prop": return this.emitProp(expr);
      default: return null;
    }
  }

  private emitCallbackType(
    name: string,
    shapes: ReadonlyMap<string, RustClosureShape>,
    markers: readonly string[],
    runtime: { variant: string; fields: string } | null,
  ): void {
    this.context.line("#[derive(Clone)]");
    this.context.line(`enum ${name} {`);
    this.context.pushIndent();
    for (const marker of markers) this.context.line(`${marker},`);
    if (runtime !== null) this.context.line(`${runtime.variant}(${runtime.fields}),`);
    for (const shape of shapes.values()) {
      this.context.line(`${this.variant(shape)}(runtime::Gc<${this.context.closureName(shape)}>),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`impl runtime::Trace for ${name} { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { match self {`);
    this.context.pushIndent();
    for (const marker of markers) this.context.line(`Self::${marker} => {},`);
    if (runtime !== null) this.context.line(`Self::${runtime.variant}(_, trace) => trace(tracer),`);
    for (const shape of shapes.values()) this.context.line(`Self::${this.variant(shape)}(callback) => tracer.edge(callback),`);
    this.context.popIndent();
    this.context.line("} } }");
  }

  private emitEventHelpers(loc: SrcLoc): void {
    const byteArms: string[] = [];
    const stringArms: string[] = [];
    const voidArms: string[] = [];
    const errorArms: string[] = [];
    for (const shape of this.context.listenerShapes.values()) {
      if (shape.type.rest === true) continue;
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "bytes") {
        const call = this.context.emitClosureDispatch("callback", shape.type, ["sc_chunk.clone()"], loc);
        byteArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
      }
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "dyn") {
        const chunk = `${this.context.dynTypeName()}::Buffer(sc_chunk.clone())`;
        const call = this.context.emitClosureDispatch("callback", shape.type, [chunk], loc);
        byteArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
        const text = `${this.context.dynTypeName()}::String(sc_chunk.clone())`;
        const stringCall = this.context.emitClosureDispatch("callback", shape.type, [text], loc);
        stringArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${stringCall}; },`);
      }
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "string") {
        const call = this.context.emitClosureDispatch("callback", shape.type, ["sc_chunk.clone()"], loc);
        stringArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
      }
      if (shape.type.params.length === 0) {
        const call = this.context.emitClosureDispatch("callback", shape.type, [], loc);
        byteArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
        stringArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
        voidArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
      }
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "object" &&
        shape.type.params[0].className === "%Error") {
        const call = this.context.emitClosureDispatch("callback", shape.type, ["sc_error.clone()"], loc);
        errorArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
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
    byteArms.push("_ => unreachable!(\"scriptc invariant: Transform data listener signature\"),");
    stringArms.push("_ => unreachable!(\"scriptc invariant: Transform string data listener signature\"),");
    voidArms.push("_ => unreachable!(\"scriptc invariant: Transform lifecycle listener signature\"),");
    errorArms.push("_ => unreachable!(\"scriptc invariant: Transform error listener signature\"),");
    this.context.line("fn sc_transform_emit_data(sc_transform: &ScTransform, sc_chunk: runtime::JsBytes<u8>) {");
    this.context.pushIndent();
    this.emitEventLoop("data", byteArms);
    this.context.line("runtime::readable_write_pipes(&runtime::transform_readable(sc_transform), sc_chunk);");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_transform_emit_string(sc_transform: &ScTransform, sc_chunk: runtime::JsString) {");
    this.context.pushIndent();
    this.emitEventLoop("data", stringArms);
    this.context.line("runtime::readable_write_pipes(&runtime::transform_readable(sc_transform), runtime::buffer_from_string(&sc_chunk, &runtime::string(\"utf8\")));");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_transform_emit_void(sc_transform: &ScTransform, sc_event: &str) {");
    this.context.pushIndent();
    this.emitEventLoop("sc_event", voidArms, true);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_transform_emit_error(sc_transform: &ScTransform, sc_error: runtime::JsError) {");
    this.context.pushIndent();
    this.context.line("let sc_emitter = runtime::transform_emitter(sc_transform);");
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
    this.context.line("fn sc_transform_destroy_pipeline(sc_transform: &ScTransform, sc_error: runtime::JsError) { let sc_readable = runtime::transform_readable(sc_transform); let sc_writable = runtime::transform_writable(sc_transform); let sc_readable_changed = runtime::readable_destroy(&sc_readable, Some(sc_error.clone())); let sc_writable_changed = runtime::writable_destroy(&sc_writable, Some(sc_error.clone())); if sc_readable_changed || sc_writable_changed { let sc_transform = sc_transform.clone(); runtime::process_next_tick(Box::new(move || { sc_transform_emit_error(&sc_transform, sc_error); sc_transform_emit_void(&sc_transform, \"close\"); })); } }");
    this.context.line("fn sc_transform_emit_output(sc_transform: &ScTransform, sc_chunk: runtime::JsBytes<u8>) { let sc_readable = runtime::transform_readable(sc_transform); let _ = runtime::readable_push(&sc_readable, sc_chunk); if runtime::readable_is_flowing(&sc_readable) { if let Some(sc_chunk) = runtime::readable_pop(&sc_readable) { match sc_chunk { runtime::ReadableChunk::Bytes(value) => sc_transform_emit_data(sc_transform, value), runtime::ReadableChunk::String(value) => sc_transform_emit_string(sc_transform, value), } } } }");
  }

  private emitEventLoop(event: string, arms: readonly string[], dynamic = false): void {
    this.context.line("let sc_emitter = runtime::transform_emitter(sc_transform);");
    this.context.line(`let sc_name = runtime::string(${dynamic ? event : `"${event}"`});`);
    this.context.line("let sc_snapshot = runtime::emitter_snapshot(&sc_emitter, &sc_name);");
    this.context.line("for sc_registration in sc_snapshot { if !runtime::emitter_listener_should_invoke(&sc_registration) { continue; } if sc_registration.once { let _ = runtime::emitter_remove_registration(&sc_emitter, &sc_name, sc_registration.registration); } match sc_registration.callback {");
    this.context.pushIndent();
    for (const arm of arms) this.context.line(arm);
    this.context.popIndent();
    this.context.line("} }");
  }

  private emitReadableHelpers(): void {
    this.context.line("fn sc_transform_read_drain(sc_transform: ScTransform) { let sc_readable = runtime::transform_readable(&sc_transform); runtime::readable_begin_drain(&sc_readable); if runtime::readable_take_resume(&sc_readable, false) { sc_transform_emit_void(&sc_transform, \"resume\"); } if let Some(sc_chunk) = runtime::readable_pop(&sc_readable) { match sc_chunk { runtime::ReadableChunk::Bytes(value) => sc_transform_emit_data(&sc_transform, value), runtime::ReadableChunk::String(value) => sc_transform_emit_string(&sc_transform, value), } runtime::readable_end_drain(&sc_readable); sc_transform_read_schedule(&sc_transform); return; } if runtime::readable_take_end(&sc_readable) { sc_transform_emit_void(&sc_transform, \"end\"); runtime::readable_end_pipes(&sc_readable); let sc_duplex = runtime::transform_duplex(&sc_transform); if runtime::duplex_take_close(&sc_duplex) { sc_transform_emit_void(&sc_transform, \"close\"); } runtime::readable_end_drain(&sc_readable); return; } runtime::readable_end_drain(&sc_readable); }");
    this.context.line("fn sc_transform_read_schedule(sc_transform: &ScTransform) { let sc_readable = runtime::transform_readable(sc_transform); if runtime::readable_schedule(&sc_readable) { let sc_transform = sc_transform.clone(); runtime::process_next_tick(Box::new(move || sc_transform_read_drain(sc_transform))); } }");
    this.context.line("fn sc_transform_start_flowing(sc_transform: &ScTransform) { let sc_readable = runtime::transform_readable(sc_transform); runtime::readable_start_flowing(&sc_readable); sc_transform_read_schedule(sc_transform); }");
  }

  private emitWriteHelpers(loc: SrcLoc): void {
    const arms: string[] = [];
    for (const shape of this.context.streams.transformCallbackShapes.values()) {
      const completion = this.completionType(shape.type, "Transform transform", loc);
      const completionShape = this.context.closureShapeForType(completion, loc);
      const params = completion.params.map((_, index) => `sc_arg_${index}`);
      const errorType = completion.params[0];
      const errorParam = params[0];
      if (errorType === undefined || errorParam === undefined) {
        this.context.unsupported("Transform transform completion error", loc);
      }
      const completedError = this.errorOption(errorParam, errorType, loc);
      const outputType = completion.params[1];
      const output = params[1] === undefined || outputType === undefined
        ? ""
        : this.emitOutput(params[1], outputType, "sc_transform", loc);
      const ignored = params.filter((_, index) => index > 1);
      const ignore = ignored.length === 0 ? "" : `let _ = (${ignored.join(", ")});`;
      const done = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_transform = sc_transform.clone(); let sc_done = sc_done.clone(); let sc_called = std::rc::Rc::new(std::cell::Cell::new(false)); move |${params.join(", ")}| { ${ignore} if sc_called.replace(true) { return; } if let Some(sc_error) = ${completedError} { sc_transform_destroy_pipeline(&sc_transform, sc_error); return; } ${output} let sc_writable = runtime::transform_writable(&sc_transform); runtime::writable_complete_write(&sc_writable, sc_length); sc_transform_after_write(&sc_transform, sc_done.clone()); } })), trace: Some(std::rc::Rc::new({ let sc_transform = sc_transform.clone(); let sc_done = sc_done.clone(); move |tracer| { tracer.edge(&sc_transform); runtime::Trace::trace(&sc_done, tracer); } })) })`;
      const call = this.context.emitClosureDispatch("callback", shape.type, [
        "sc_transform.clone()", "sc_chunk.clone()", "runtime::string(\"buffer\")", done,
      ], loc);
      arms.push(`ScTransformCallback::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
    }
    if (this.context.streams.usesTransformSubclass) {
      arms.push("ScTransformCallback::RuntimeTransform(callback, _) => callback(sc_transform.clone(), sc_chunk, sc_length, sc_done),");
    }
    arms.push("ScTransformCallback::Never => { if runtime::transform_is_passthrough(sc_transform) { sc_transform_emit_output(sc_transform, sc_chunk); let sc_writable = runtime::transform_writable(sc_transform); runtime::writable_complete_write(&sc_writable, sc_length); sc_transform_after_write(sc_transform, sc_done); } else { runtime::throw_error_code(\"The _transform() method is not implemented\".to_owned(), \"ERR_METHOD_NOT_IMPLEMENTED\"); } },");
    arms.push("_ => unreachable!(\"scriptc invariant: Transform callback signature\"),");
    this.context.line("fn sc_transform_call_write(sc_transform: &ScTransform, sc_chunk: runtime::JsBytes<u8>, sc_length: usize, sc_done: ScTransformDone) {");
    this.context.pushIndent();
    this.context.line("let sc_callback = runtime::transform_callback(sc_transform).unwrap_or(ScTransformCallback::Never);");
    this.context.line(`match sc_callback { ${arms.join(" ")} }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_transform_drain_write(sc_transform: &ScTransform) { let sc_writable = runtime::transform_writable(sc_transform); if runtime::writable_is_corked(&sc_writable) { return; } let Some((sc_chunk, sc_length, sc_done)) = runtime::writable_take_write(&sc_writable) else { return; }; sc_transform_call_write(sc_transform, sc_chunk, sc_length, sc_done); }");
    const doneArms: string[] = ["ScTransformDone::Never => {},"];
    for (const shape of this.context.streams.transformDoneShapes.values()) {
      const call = this.context.emitClosureDispatch("callback", shape.type, [], loc);
      doneArms.push(`ScTransformDone::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
    }
    this.context.line(`fn sc_transform_call_done(sc_done: ScTransformDone) { match sc_done { ${doneArms.join(" ")} } }`);
    this.context.line("fn sc_transform_after_write(sc_transform: &ScTransform, sc_done: ScTransformDone) { sc_transform_drain_write(sc_transform); let sc_writable = runtime::transform_writable(sc_transform); if runtime::writable_take_drain(&sc_writable) { sc_transform_emit_void(sc_transform, \"drain\"); runtime::writable_resume_sources(&sc_writable); } sc_transform_call_done(sc_done); }");
  }

  private emitFlushHelpers(loc: SrcLoc): void {
    const arms: string[] = [];
    for (const shape of this.context.streams.transformFlushShapes.values()) {
      const completion = this.completionType(shape.type, "Transform flush", loc);
      const completionShape = this.context.closureShapeForType(completion, loc);
      const params = completion.params.map((_, index) => `sc_arg_${index}`);
      const outputType = completion.params[1];
      const output = params[1] === undefined || outputType === undefined
        ? ""
        : this.emitOutput(params[1], outputType, "sc_transform", loc);
      const ignored = params.filter((_, index) => index !== 1);
      const ignore = ignored.length === 0 ? "" : `let _ = (${ignored.join(", ")});`;
      const done = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_transform = sc_transform.clone(); let sc_finish = sc_finish.clone(); let sc_called = std::rc::Rc::new(std::cell::Cell::new(false)); move |${params.join(", ")}| { ${ignore} if sc_called.replace(true) { return; } ${output} sc_finish(); } })), trace: Some(std::rc::Rc::new({ let sc_transform = sc_transform.clone(); let sc_finish_trace = sc_finish_trace.clone(); move |tracer| { tracer.edge(&sc_transform); sc_finish_trace(tracer); } })) })`;
      const call = this.context.emitClosureDispatch("callback", shape.type, ["sc_transform.clone()", done], loc);
      arms.push(`ScTransformFlush::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
    }
    if (this.context.streams.usesTransformSubclass) {
      arms.push("ScTransformFlush::RuntimeFlush(callback, _) => callback(sc_transform.clone(), sc_finish, sc_finish_trace),");
    }
    arms.push("ScTransformFlush::Never => sc_finish(),");
    arms.push("_ => unreachable!(\"scriptc invariant: Transform flush callback signature\"),");
    this.context.line("fn sc_transform_call_flush(sc_transform: &ScTransform, sc_finish: std::rc::Rc<dyn Fn()>, sc_finish_trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>) {");
    this.context.pushIndent();
    this.context.line("let sc_callback = runtime::transform_flush_callback(sc_transform).unwrap_or(ScTransformFlush::Never);");
    this.context.line(`match sc_callback { ${arms.join(" ")} }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_transform_end_from_pipe(sc_transform: &ScTransform) { let sc_writable = runtime::transform_writable(sc_transform); runtime::writable_mark_ended(&sc_writable); let sc_finish: std::rc::Rc<dyn Fn()> = std::rc::Rc::new({ let sc_transform = sc_transform.clone(); move || { let sc_readable = runtime::transform_readable(&sc_transform); let _ = runtime::readable_push_null(&sc_readable); sc_transform_read_schedule(&sc_transform); let sc_writable = runtime::transform_writable(&sc_transform); if runtime::writable_take_prefinish(&sc_writable) { sc_transform_emit_void(&sc_transform, \"prefinish\"); } if runtime::writable_schedule_finish(&sc_writable) { let sc_transform = sc_transform.clone(); runtime::process_next_tick(Box::new(move || { let sc_writable = runtime::transform_writable(&sc_transform); runtime::writable_mark_finished(&sc_writable); sc_transform_emit_void(&sc_transform, \"finish\"); let sc_duplex = runtime::transform_duplex(&sc_transform); if runtime::duplex_take_close(&sc_duplex) { sc_transform_emit_void(&sc_transform, \"close\"); } })); } } }); let sc_finish_trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)> = std::rc::Rc::new({ let sc_transform = sc_transform.clone(); move |tracer| tracer.edge(&sc_transform) }); sc_transform_call_flush(sc_transform, sc_finish, sc_finish_trace); }");
  }

  private emitNew(expr: RustLibCallExpr): string {
    const flagsExpr = expr.args[7];
    const passthrough = expr.fn === "passthrough.new";
    const expectedClass = passthrough ? "%PassThrough" : "%Transform";
    if (expr.args.length < 8 || flagsExpr?.kind !== "numLit" || expr.type.kind !== "object" ||
      expr.type.className !== expectedClass) this.context.unsupported("Transform constructor shape", expr.loc);
    const flags = flagsExpr.value;
    if ((flags & ~3) !== 0) this.context.unsupported("Transform constructor callback set", expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    let index = 8;
    let transform = "Option::<ScTransformCallback>::None";
    let flush = "Option::<ScTransformFlush>::None";
    if ((flags & 1) !== 0) {
      const callback = expr.args[index];
      if (callback?.type.kind !== "func") this.context.unsupported("Transform callback shape", expr.loc);
      const shape = this.context.streams.transformCallbackShapes.get(typeKey(callback.type));
      if (!shape) this.context.unsupported("unregistered Transform callback", expr.loc);
      transform = `Some(ScTransformCallback::${this.variant(shape)}(${values[index]}))`;
      index += 1;
    }
    if ((flags & 2) !== 0) {
      const callback = expr.args[index];
      if (callback?.type.kind !== "func") this.context.unsupported("Transform flush shape", expr.loc);
      const shape = this.context.streams.transformFlushShapes.get(typeKey(callback.type));
      if (!shape) this.context.unsupported("unregistered Transform flush", expr.loc);
      flush = `Some(ScTransformFlush::${this.variant(shape)}(${values[index]}))`;
      index += 1;
    }
    if (index !== expr.args.length) this.context.unsupported("Transform constructor arity", expr.loc);
    return `{ ${this.bind(expr.args, values)} let _ = (${values[5]}, ${values[6]}, ${values[7]}); let sc_emitter = runtime::emitter_new_shaped::<ScEmitterListener>(&["close", "error", "prefinish", "finish", "drain", "data", "end", "readable"]); let sc_readable = runtime::readable_new::<ScEmitterListener, ScTransformRead>(${values[0]}, ${values[2]}, ${values[3]}, Option::<ScTransformRead>::None, Option::<ScTransformRead>::None); runtime::readable_set_emitter(&sc_readable, sc_emitter.clone()); let sc_writable = runtime::writable_new::<ScEmitterListener, ScTransformWrite, ScTransformFinal, ScTransformDone>(${values[1]}, ${values[2]}, ${values[3]}, Some(ScTransformWrite::Transform), Some(ScTransformFinal::Flush)); runtime::writable_set_emitter(&sc_writable, sc_emitter); let sc_duplex: ScTransformDuplex = runtime::duplex_new(sc_readable, sc_writable, ${values[4]}); runtime::transform_new(sc_duplex, ${transform}, ${flush}, ${passthrough}) }`;
  }

  private emitInit(expr: RustLibCallExpr): string {
    const [receiver, hwmRead, hwmWrite, autoDestroy, emitClose, allowHalfOpen, readableSide, writableSide, flags] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className === "%Transform" ||
      this.context.runtimeStreamBase(receiver.type.className) !== "%Transform" || hwmRead?.type.kind !== "f64" ||
      hwmWrite?.type.kind !== "f64" || autoDestroy?.type.kind !== "bool" || emitClose?.type.kind !== "bool" ||
      allowHalfOpen?.type.kind !== "bool" || readableSide?.type.kind !== "bool" || writableSide?.type.kind !== "bool" ||
      flags?.kind !== "numLit" || (flags.value & ~3) !== 0 || expr.type.kind !== "void") {
      this.context.unsupported("Transform subclass constructor shape", expr.loc);
    }
    const passthrough = expr.fn === "passthrough.init";
    const values = expr.args.map(() => this.context.nextTemporary());
    const owner = this.requiredValue(values, 0, expr.loc);
    let index = 9;
    let transform = "Option::<ScTransformCallback>::None";
    let flush = "Option::<ScTransformFlush>::None";
    if ((flags.value & 1) !== 0) {
      const callback = expr.args[index];
      const params = callback?.type.kind === "func" ? callback.type.params : [];
      const completion = params[3];
      if (callback?.type.kind !== "func" || callback.type.ret.kind !== "void" || params.length !== 4 ||
        params[0]?.kind !== "object" || params[0].className !== receiver.type.className) {
        this.context.unsupported("Transform subclass transform callback shape", expr.loc);
      }
      const callbackValue = this.requiredValue(values, index, expr.loc);
      let dispatch: string;
      if (completion?.kind === "dyn") {
        if (params[1]?.kind !== "dyn" || params[2]?.kind !== "dyn") {
          this.context.unsupported("dynamic Transform subclass callback shape", expr.loc);
        }
        const completionShape = this.dynamicCompletionShape(expr.loc);
        const dyn = this.context.dynTypeName();
        const output = `match sc_output { ${dyn}::Undefined | ${dyn}::Null => {}, ${dyn}::String(sc_output) => sc_transform_emit_output(&sc_transform, runtime::buffer_from_string(&sc_output, &runtime::string("utf8"))), ${dyn}::Bytes(sc_output) | ${dyn}::Buffer(sc_output) => sc_transform_emit_output(&sc_transform, sc_output), sc_output => sc_dyn_arg_type_fail("transform callback output", "a string, Buffer, null, or undefined", &sc_output), }`;
        const done = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_completion = sc_completion.clone(); move |sc_error, sc_output| { if sc_completion.2.replace(true) { return; } let sc_transform = sc_completion.0.clone(); if !matches!(&sc_error, ${dyn}::Undefined | ${dyn}::Null) { sc_transform_destroy_pipeline(&sc_transform, sc_dyn_error_unbox(sc_error)); return; } ${output} let sc_writable = runtime::transform_writable(&sc_transform); runtime::writable_complete_write(&sc_writable, sc_length); sc_transform_after_write(&sc_transform, sc_completion.1.clone()); } })), trace: Some(std::rc::Rc::new({ let sc_completion = sc_completion.clone(); move |tracer| { tracer.edge(&sc_completion.0); runtime::Trace::trace(&sc_completion.1, tracer); } })) })`;
        const dynamicDone = `${dyn}::${this.context.dynFunctionVariant(completionShape)}(${done}, runtime::empty_string(), runtime::map_new())`;
        dispatch = this.context.emitClosureDispatch("sc_callback", callback.type, [
          "sc_owner", `${dyn}::Buffer(sc_chunk)`, `${dyn}::String(runtime::string("buffer"))`, dynamicDone,
        ], expr.loc);
      } else {
        const errorType = completion?.kind === "func" ? completion.params[0] : undefined;
        const outputType = completion?.kind === "func" ? completion.params[1] : undefined;
        if (params[1]?.kind !== "bytes" || params[1].elem !== "u8" || params[2]?.kind !== "string" ||
          completion?.kind !== "func" || completion.ret.kind !== "void" || completion.params.length !== 2 ||
          errorType === undefined || outputType === undefined) {
          this.context.unsupported("Transform subclass transform callback shape", expr.loc);
        }
        const completionShape = this.context.closureShapeForType(completion, expr.loc);
        const completedError = this.errorOption("sc_error", errorType, expr.loc);
        const output = this.emitOutput("sc_output", outputType, "sc_transform", expr.loc);
        const done = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_completion = sc_completion.clone(); move |sc_error, sc_output| { if sc_completion.2.replace(true) { return; } let sc_transform = sc_completion.0.clone(); if let Some(sc_error) = ${completedError} { sc_transform_destroy_pipeline(&sc_transform, sc_error); return; } ${output} let sc_writable = runtime::transform_writable(&sc_transform); runtime::writable_complete_write(&sc_writable, sc_length); sc_transform_after_write(&sc_transform, sc_completion.1.clone()); } })), trace: Some(std::rc::Rc::new({ let sc_completion = sc_completion.clone(); move |tracer| { tracer.edge(&sc_completion.0); runtime::Trace::trace(&sc_completion.1, tracer); } })) })`;
        dispatch = this.context.emitClosureDispatch("sc_callback", callback.type, [
          "sc_owner", "sc_chunk", "runtime::string(\"buffer\")", done,
        ], expr.loc);
      }
      transform = `Some({ let sc_context = std::rc::Rc::new((${owner}.clone(), ${callbackValue}.clone())); ScTransformCallback::RuntimeTransform(std::rc::Rc::new({ let sc_context = sc_context.clone(); move |sc_transform, sc_chunk, sc_length, sc_done| { let sc_owner = sc_context.0.clone(); let sc_callback = sc_context.1.clone(); let sc_completion = std::rc::Rc::new((sc_transform, sc_done, std::cell::Cell::new(false))); let _ = ${dispatch}; } }), std::rc::Rc::new(move |tracer| { tracer.edge(&sc_context.0); tracer.edge(&sc_context.1); })) })`;
      index += 1;
    }
    if ((flags.value & 2) !== 0) {
      const callback = expr.args[index];
      const params = callback?.type.kind === "func" ? callback.type.params : [];
      const completion = params[1];
      const errorType = completion?.kind === "func" ? completion.params[0] : undefined;
      const outputType = completion?.kind === "func" ? completion.params[1] : undefined;
      if (callback?.type.kind !== "func" || callback.type.ret.kind !== "void" || params.length !== 2 ||
        params[0]?.kind !== "object" || params[0].className !== receiver.type.className ||
        completion?.kind !== "func" || completion.ret.kind !== "void" || completion.params.length !== 2 ||
        errorType === undefined || outputType === undefined) {
        this.context.unsupported("Transform subclass flush callback shape", expr.loc);
      }
      const callbackValue = this.requiredValue(values, index, expr.loc);
      const completionShape = this.context.closureShapeForType(completion, expr.loc);
      const completedError = this.errorOption("sc_error", errorType, expr.loc);
      const output = this.emitOutput("sc_output", outputType, "sc_transform", expr.loc);
      const done = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_completion = sc_completion.clone(); move |sc_error, sc_output| { if sc_completion.2.replace(true) { return; } let sc_transform = sc_completion.0.clone(); if let Some(sc_error) = ${completedError} { sc_transform_destroy_pipeline(&sc_transform, sc_error); return; } ${output} (sc_completion.1)(); } })), trace: Some(std::rc::Rc::new({ let sc_completion = sc_completion.clone(); move |tracer| { tracer.edge(&sc_completion.0); (sc_completion.3)(tracer); } })) })`;
      const dispatch = this.context.emitClosureDispatch("sc_callback", callback.type, ["sc_owner", done], expr.loc);
      flush = `Some({ let sc_context = std::rc::Rc::new((${owner}.clone(), ${callbackValue}.clone())); ScTransformFlush::RuntimeFlush(std::rc::Rc::new({ let sc_context = sc_context.clone(); move |sc_transform, sc_finish, sc_finish_trace| { let sc_owner = sc_context.0.clone(); let sc_callback = sc_context.1.clone(); let sc_completion = std::rc::Rc::new((sc_transform, sc_finish, std::cell::Cell::new(false), sc_finish_trace)); let _ = ${dispatch}; } }), std::rc::Rc::new(move |tracer| { tracer.edge(&sc_context.0); tracer.edge(&sc_context.1); })) })`;
      index += 1;
    }
    if (index !== expr.args.length) this.context.unsupported("Transform subclass constructor arity", expr.loc);
    return `{ ${this.bind(expr.args, values)} let sc_emitter = runtime::emitter_new_shaped::<ScEmitterListener>(&["close", "error", "prefinish", "finish", "drain", "data", "end", "readable"]); let sc_readable = runtime::readable_new::<ScEmitterListener, ScTransformRead>(${values[1]}, ${values[3]}, ${values[4]}, Option::<ScTransformRead>::None, Option::<ScTransformRead>::None); runtime::readable_set_emitter(&sc_readable, sc_emitter.clone()); let sc_writable = runtime::writable_new::<ScEmitterListener, ScTransformWrite, ScTransformFinal, ScTransformDone>(${values[2]}, ${values[3]}, ${values[4]}, Some(ScTransformWrite::Transform), Some(ScTransformFinal::Flush)); runtime::writable_set_emitter(&sc_writable, sc_emitter); let sc_duplex: ScTransformDuplex = runtime::duplex_new(sc_readable, sc_writable, ${values[5]}); let sc_transform = runtime::transform_new(sc_duplex, ${transform}, ${flush}, ${passthrough}); let _ = (${values[6]}, ${values[7]}, ${values[8]}); ${owner}.with_mut(|object| object.sc_transform = Some(sc_transform)); }`;
  }

  private emitNextChunkDynamic(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    if (!this.isTransform(receiver) || expr.args.length !== 1 ||
      expr.type.kind !== "promise" || expr.type.inner.kind !== "dyn") {
      this.context.unsupported("Transform async iterator shape", expr.loc);
    }
    const dyn = this.context.dynTypeName();
    const owner = this.context.nextTemporary();
    const result = this.context.nextTemporary();
    const target = this.context.nextTemporary();
    const traced = this.context.nextTemporary();
    const outcome = this.context.nextTemporary();
    const handle = this.transformHandle(owner, receiver.type, expr.loc);
    return `{ let ${owner} = ${this.context.emitExpr(receiver)}; let sc_transform = ${handle}; let sc_readable = runtime::transform_readable(&sc_transform); let ${result}: runtime::JsPromise<${dyn}> = runtime::promise_new(); let ${target} = ${result}.clone(); let ${traced} = ${result}.clone(); let sc_registered = runtime::readable_set_next_waiter(&sc_readable, std::rc::Rc::new(move |${outcome}| match ${outcome} { Ok(Some(runtime::ReadableChunk::Bytes(value))) => { let _ = runtime::promise_fulfill(&${target}, ${dyn}::Buffer(value)); }, Ok(Some(runtime::ReadableChunk::String(value))) => { let _ = runtime::promise_fulfill(&${target}, ${dyn}::String(value)); }, Ok(None) => { let _ = runtime::promise_fulfill(&${target}, ${dyn}::Undefined); }, Err(reason) => { let _ = runtime::promise_reject(&${target}, reason); }, }), std::rc::Rc::new(move |tracer| tracer.edge(&${traced}))); if !sc_registered { let sc_reason = runtime::caught_value(runtime::error_new("Error", runtime::string("Readable already has a pending async iterator read"))); let _ = runtime::promise_reject(&${result}, sc_reason); } ${result} }`;
  }

  private emitWrite(expr: RustLibCallExpr, stringChunk: boolean): string {
    const receiver = expr.args[0];
    const chunk = expr.args[1];
    if (!this.isTransform(receiver) || chunk?.type.kind !== (stringChunk ? "string" : "bytes") || expr.type.kind !== "bool" ||
      (expr.args.length !== 2 && expr.args.length !== 3)) this.context.unsupported("Transform write shape", expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    const converted = stringChunk ? `runtime::buffer_from_string(&${values[1]}, &runtime::string("utf8"))` : values[1];
    let done = "ScTransformDone::Never";
    const callback = expr.args[2];
    if (callback !== undefined) {
      if (callback.type.kind !== "func" || callback.type.params.length !== 0) this.context.unsupported("Transform write completion", expr.loc);
      const shape = this.context.streams.transformDoneShapes.get(typeKey(callback.type));
      if (!shape) this.context.unsupported("unregistered Transform completion", expr.loc);
      done = `ScTransformDone::${this.variant(shape)}(${values[2]})`;
    }
    const handle = this.transformHandle(this.requiredValue(values, 0, expr.loc), receiver.type, expr.loc);
    return `{ ${this.bind(expr.args, values)} let sc_transform = ${handle}; let sc_writable = runtime::transform_writable(&sc_transform); let sc_result = runtime::writable_enqueue(&sc_writable, ${converted}, ${done}); sc_transform_drain_write(&sc_transform); sc_result }`;
  }

  private emitEnd(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    const flagsExpr = expr.args[1];
    if (!this.isTransform(receiver) || flagsExpr?.kind !== "numLit" || receiver === undefined ||
      typeKey(expr.type) !== typeKey(receiver.type)) {
      this.context.unsupported("Transform end shape", expr.loc);
    }
    const flags = flagsExpr.value;
    if ((flags & ~7) !== 0 || (flags & 3) === 3 || (flags & 4) !== 0) this.context.unsupported("Transform end flags", expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    let index = 2;
    let write = "";
    if ((flags & 3) !== 0) {
      const stringChunk = (flags & 2) !== 0;
      const chunk = expr.args[index];
      if (chunk?.type.kind !== (stringChunk ? "string" : "bytes")) this.context.unsupported("Transform end chunk", expr.loc);
      const converted = stringChunk ? `runtime::buffer_from_string(&${values[index]}, &runtime::string("utf8"))` : values[index];
      write = `let _ = runtime::writable_enqueue(&sc_writable, ${converted}, ScTransformDone::Never); sc_transform_drain_write(&sc_transform);`;
      index += 1;
    }
    if (index !== expr.args.length) this.context.unsupported("Transform end arity", expr.loc);
    const finish = `let sc_finish: std::rc::Rc<dyn Fn()> = std::rc::Rc::new({ let sc_transform = sc_transform.clone(); move || { let sc_readable = runtime::transform_readable(&sc_transform); let _ = runtime::readable_push_null(&sc_readable); sc_transform_read_schedule(&sc_transform); let sc_writable = runtime::transform_writable(&sc_transform); if runtime::writable_take_prefinish(&sc_writable) { sc_transform_emit_void(&sc_transform, "prefinish"); } if runtime::writable_schedule_finish(&sc_writable) { let sc_transform = sc_transform.clone(); runtime::process_next_tick(Box::new(move || { let sc_writable = runtime::transform_writable(&sc_transform); runtime::writable_mark_finished(&sc_writable); sc_transform_emit_void(&sc_transform, "finish"); let sc_duplex = runtime::transform_duplex(&sc_transform); if runtime::duplex_take_close(&sc_duplex) { sc_transform_emit_void(&sc_transform, "close"); } })); } } });`;
    const trace = `let sc_finish_trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)> = std::rc::Rc::new({ let sc_transform = sc_transform.clone(); move |tracer| tracer.edge(&sc_transform) });`;
    const handle = this.transformHandle(this.requiredValue(values, 0, expr.loc), receiver.type, expr.loc);
    return `{ ${this.bind(expr.args, values)} let sc_transform = ${handle}; let sc_writable = runtime::transform_writable(&sc_transform); runtime::writable_mark_ended(&sc_writable); ${write} ${finish} ${trace} sc_transform_call_flush(&sc_transform, sc_finish, sc_finish_trace); ${values[0]} }`;
  }

  private emitPush(expr: RustLibCallExpr, stringChunk: boolean): string {
    const receiver = expr.args[0];
    const chunk = expr.args[1];
    if (!this.isTransform(receiver) || expr.args.length !== 2 ||
      chunk?.type.kind !== (stringChunk ? "string" : "bytes") || expr.type.kind !== "bool") {
      this.context.unsupported("Transform push shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const converted = stringChunk ? `runtime::buffer_from_string(&${values[1]}, &runtime::string("utf8"))` : values[1];
    const handle = this.transformHandle(this.requiredValue(values, 0, expr.loc), receiver.type, expr.loc);
    return `{ ${this.bind(expr.args, values)} let sc_transform = ${handle}; let sc_readable = runtime::transform_readable(&sc_transform); let sc_result = runtime::readable_push(&sc_readable, ${converted}); if runtime::readable_is_flowing(&sc_readable) { if let Some(sc_chunk) = runtime::readable_pop(&sc_readable) { match sc_chunk { runtime::ReadableChunk::Bytes(value) => sc_transform_emit_data(&sc_transform, value), runtime::ReadableChunk::String(value) => sc_transform_emit_string(&sc_transform, value), } } } sc_result }`;
  }

  private emitSetEncoding(expr: RustLibCallExpr): string {
    const [receiver, encoding] = expr.args;
    if (!this.isTransform(receiver) || encoding?.type.kind !== "string" || expr.args.length !== 2 ||
      typeKey(expr.type) !== typeKey(receiver.type)) {
      this.context.unsupported("Transform setEncoding shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const handle = this.transformHandle(this.requiredValue(values, 0, expr.loc), receiver.type, expr.loc);
    return `{ ${this.bind(expr.args, values)} let sc_transform = ${handle}; runtime::readable_set_encoding(&runtime::transform_readable(&sc_transform), &${values[1]}); ${values[0]} }`;
  }

  private emitSetCallback(expr: RustLibCallExpr, transform: boolean): string {
    const [receiver, callback] = expr.args;
    if (!this.isTransform(receiver) || callback?.type.kind !== "func" ||
      expr.args.length !== 2 || expr.type.kind !== "void") {
      this.context.unsupported(`Transform assigned ${transform ? "transform" : "flush"} callback shape`, expr.loc);
    }
    const shapes = transform
      ? this.context.streams.transformCallbackShapes
      : this.context.streams.transformFlushShapes;
    const shape = shapes.get(typeKey(callback.type));
    if (shape === undefined) {
      this.context.unsupported(`unregistered assigned Transform ${transform ? "transform" : "flush"} callback`, expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const handle = this.transformHandle(this.requiredValue(values, 0, expr.loc), receiver.type, expr.loc);
    const runtime = transform ? "transform_set_callback" : "transform_set_flush_callback";
    const variant = transform ? "ScTransformCallback" : "ScTransformFlush";
    return `{ ${this.bind(expr.args, values)} let sc_transform = ${handle}; runtime::${runtime}(&sc_transform, ${variant}::${this.variant(shape)}(${values[1]})); }`;
  }

  private emitPushNull(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    if (!this.isTransform(receiver) || expr.args.length !== 1 || expr.type.kind !== "bool") {
      this.context.unsupported("Transform null push shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    const handle = this.transformHandle(value, receiver.type, expr.loc);
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; let sc_transform = ${handle}; let sc_result = runtime::readable_push_null(&runtime::transform_readable(&sc_transform)); sc_transform_read_schedule(&sc_transform); sc_result }`;
  }

  private emitProp(expr: RustLibCallExpr): string {
    const [receiver, name] = expr.args;
    if (!this.isTransform(receiver) || expr.args.length !== 2 || name?.type.kind !== "string" ||
      (expr.type.kind !== "f64" && expr.type.kind !== "bool")) {
      this.context.unsupported("Transform property shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const result = expr.type.kind === "f64"
      ? `match ${values[1]}.as_ref() { "readableHighWaterMark" | "readableLength" => runtime::readable_prop(&runtime::transform_readable(&sc_transform), &${values[1]}), _ => runtime::writable_number_prop(&runtime::transform_writable(&sc_transform), &${values[1]}), }`
      : `match ${values[1]}.as_ref() { "allowHalfOpen" => runtime::duplex_allow_half_open(&runtime::transform_duplex(&sc_transform)), "readable" | "readableEnded" | "readableObjectMode" => runtime::readable_bool_prop(&runtime::transform_readable(&sc_transform), &${values[1]}), _ => runtime::writable_bool_prop(&runtime::transform_writable(&sc_transform), &${values[1]}), }`;
    const handle = this.transformHandle(this.requiredValue(values, 0, expr.loc), receiver.type, expr.loc);
    return `{ ${this.bind(expr.args, values)} let sc_transform = ${handle}; ${result} }`;
  }

  private emitCork(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    if (!this.isTransform(receiver) || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("Transform cork shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    const handle = this.transformHandle(value, receiver.type, expr.loc);
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; let sc_transform = ${handle}; runtime::writable_cork(&runtime::transform_writable(&sc_transform)); }`;
  }

  private emitUncork(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    if (!this.isTransform(receiver) || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("Transform uncork shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    const handle = this.transformHandle(value, receiver.type, expr.loc);
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; let sc_transform = ${handle}; let sc_writable = runtime::transform_writable(&sc_transform); if runtime::writable_uncork(&sc_writable) { sc_transform_drain_write(&sc_transform); } }`;
  }

  private emitOutput(value: string, type: IrType, receiver: string, loc: SrcLoc): string {
    if (type.kind !== "union") this.context.unsupported("Transform callback output type", loc);
    const union = this.context.union(type.unionId, loc);
    const name = this.context.unionName(union.id);
    const arms = union.arms.map((arm, tag) => {
      const variant = `${name}::${this.context.unionVariant(tag)}`;
      if (arm.kind === "bytes") return `${variant}(sc_output) => sc_transform_emit_output(&${receiver}, sc_output),`;
      if (arm.kind === "string") return `${variant}(sc_output) => sc_transform_emit_output(&${receiver}, runtime::buffer_from_string(&sc_output, &runtime::string("utf8"))),`;
      if (arm.kind === "undefinedT" || arm.kind === "nullT") return `${variant} => {},`;
      this.context.unsupported(`Transform callback output arm '${arm.kind}'`, loc);
    });
    return `match ${value} { ${arms.join(" ")} }`;
  }

  private completionType(type: IrFuncType, what: string, loc: SrcLoc): IrFuncType {
    const completion = type.params.at(-1);
    if (completion?.kind !== "func") this.context.unsupported(`${what} completion shape`, loc);
    return completion;
  }

  private errorOption(value: string, type: IrType, loc: SrcLoc): string {
    if (type.kind !== "union") this.context.unsupported("Transform completion error union", loc);
    const union = this.context.union(type.unionId, loc);
    const name = this.context.unionName(union.id);
    const arms = union.arms.map((arm, tag) => {
      const variant = `${name}::${this.context.unionVariant(tag)}`;
      if (arm.kind === "object" && arm.className === "%Error") return `${variant}(sc_error) => Some(sc_error)`;
      if (arm.kind === "nullT" || arm.kind === "undefinedT") return `${variant} => None`;
      this.context.unsupported(`Transform completion error arm '${arm.kind}'`, loc);
    });
    return `match ${value} { ${arms.join(", ")} }`;
  }

  private bind(args: readonly IrExpr[], values: readonly string[]): string {
    return args.map((arg, index) => `let ${values[index]} = ${this.context.emitExpr(arg)};`).join(" ");
  }

  private requiredValue(values: readonly string[], index: number, loc: SrcLoc): string {
    const value = values[index];
    if (value === undefined) this.context.unsupported("Transform argument arity", loc);
    return value;
  }

  private isTransform(expr: IrExpr | undefined): expr is IrExpr {
    return expr?.type.kind === "object" &&
      (expr.type.className === "%Transform" || expr.type.className === "%PassThrough" ||
        this.context.runtimeStreamBase(expr.type.className) === "%Transform");
  }

  private transformHandle(value: string, type: IrType, loc: SrcLoc): string {
    if (type.kind !== "object") this.context.unsupported("Transform receiver type", loc);
    if (type.className === "%Transform" || type.className === "%PassThrough") return `${value}.clone()`;
    if (this.context.runtimeStreamBase(type.className) === "%Transform") {
      return `${value}.with(|object| object.sc_transform.as_ref().expect("scriptc: uninitialized Transform subclass").clone())`;
    }
    this.context.unsupported(`non-Transform receiver '${type.className}'`, loc);
  }

  private dynamicCompletionShape(loc: SrcLoc): RustClosureShape {
    const shape = this.context.streams.transformDynamicCompletionShape;
    if (shape === null) this.context.unsupported("unregistered dynamic Transform completion callback", loc);
    return shape;
  }

  private variant(shape: RustClosureShape): string {
    return `Closure${shape.index}`;
  }
}
