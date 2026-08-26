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
  closureName(shape: RustClosureShape): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  sourceLoc(): SrcLoc;
  rustType(type: IrType, loc?: SrcLoc): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit byte-mode Transform as a composed Duplex with typed callback bridges. */
export class RustTransformEmitter {
  constructor(private readonly context: RustTransformContext) {}

  emitTypeDefinition(): void {
    if (!this.context.streams.usesTransform) return;
    this.emitCallbackType("ScTransformRead", new Map(), ["Never"]);
    this.emitCallbackType("ScTransformWrite", new Map(), ["Transform"]);
    this.emitCallbackType("ScTransformFinal", new Map(), ["Flush"]);
    this.emitCallbackType("ScTransformDone", this.context.streams.transformDoneShapes, ["Never"]);
    this.emitCallbackType("ScTransformCallback", this.context.streams.transformCallbackShapes, ["Never"]);
    this.emitCallbackType("ScTransformFlush", this.context.streams.transformFlushShapes, ["Never"]);
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
    const receiver = expr.args[0];
    if (!this.isTransform(receiver)) return null;
    switch (expr.fn) {
      case "readable.push": return this.emitPush(expr, false);
      case "readable.pushStr": return this.emitPush(expr, true);
      case "readable.pushNull": return this.emitPushNull(expr);
      case "writable.write": return this.emitWrite(expr, false);
      case "writable.writeStr": return this.emitWrite(expr, true);
      case "writable.end": return this.emitEnd(expr);
      case "writable.cork": return this.emitCork(expr);
      case "writable.uncork": return this.emitUncork(expr);
      case "stream.prop": return this.emitProp(expr);
      default: return null;
    }
  }

  private emitCallbackType(
    name: string,
    shapes: ReadonlyMap<string, RustClosureShape>,
    markers: readonly string[],
  ): void {
    this.context.line("#[derive(Clone)]");
    this.context.line(`enum ${name} {`);
    this.context.pushIndent();
    for (const marker of markers) this.context.line(`${marker},`);
    for (const shape of shapes.values()) {
      this.context.line(`${this.variant(shape)}(runtime::Gc<${this.context.closureName(shape)}>),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`impl runtime::Trace for ${name} { fn trace(&self, tracer: &mut runtime::Tracer<'_>) { match self {`);
    this.context.pushIndent();
    for (const marker of markers) this.context.line(`Self::${marker} => {},`);
    for (const shape of shapes.values()) this.context.line(`Self::${this.variant(shape)}(callback) => tracer.edge(callback),`);
    this.context.popIndent();
    this.context.line("} } }");
  }

  private emitEventHelpers(loc: SrcLoc): void {
    const byteArms: string[] = [];
    const voidArms: string[] = [];
    for (const shape of this.context.listenerShapes.values()) {
      if (shape.type.rest === true) continue;
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "bytes") {
        const call = this.context.emitClosureDispatch("callback", shape.type, ["sc_chunk.clone()"], loc);
        byteArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
      }
      if (shape.type.params.length === 0) {
        const call = this.context.emitClosureDispatch("callback", shape.type, [], loc);
        byteArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
        voidArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
      }
    }
    byteArms.push("_ => unreachable!(\"scriptc invariant: Transform data listener signature\"),");
    voidArms.push("_ => unreachable!(\"scriptc invariant: Transform lifecycle listener signature\"),");
    this.context.line("fn sc_transform_emit_data(sc_transform: &ScTransform, sc_chunk: runtime::JsBytes<u8>) {");
    this.context.pushIndent();
    this.emitEventLoop("data", byteArms);
    this.context.line("runtime::readable_write_pipes(&runtime::transform_readable(sc_transform), sc_chunk);");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_transform_emit_void(sc_transform: &ScTransform, sc_event: &str) {");
    this.context.pushIndent();
    this.emitEventLoop("sc_event", voidArms, true);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_transform_emit_output(sc_transform: &ScTransform, sc_chunk: runtime::JsBytes<u8>) { let sc_readable = runtime::transform_readable(sc_transform); let _ = runtime::readable_push(&sc_readable, sc_chunk); if runtime::readable_is_flowing(&sc_readable) { if let Some(sc_chunk) = runtime::readable_pop(&sc_readable) { sc_transform_emit_data(sc_transform, sc_chunk); } } }");
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
    this.context.line("fn sc_transform_read_drain(sc_transform: ScTransform) { let sc_readable = runtime::transform_readable(&sc_transform); runtime::readable_begin_drain(&sc_readable); if runtime::readable_take_resume(&sc_readable, false) { sc_transform_emit_void(&sc_transform, \"resume\"); } if let Some(sc_chunk) = runtime::readable_pop(&sc_readable) { sc_transform_emit_data(&sc_transform, sc_chunk); runtime::readable_end_drain(&sc_readable); sc_transform_read_schedule(&sc_transform); return; } if runtime::readable_take_end(&sc_readable) { sc_transform_emit_void(&sc_transform, \"end\"); runtime::readable_end_pipes(&sc_readable); let sc_duplex = runtime::transform_duplex(&sc_transform); if runtime::duplex_take_close(&sc_duplex) { sc_transform_emit_void(&sc_transform, \"close\"); } runtime::readable_end_drain(&sc_readable); return; } runtime::readable_end_drain(&sc_readable); }");
    this.context.line("fn sc_transform_read_schedule(sc_transform: &ScTransform) { let sc_readable = runtime::transform_readable(sc_transform); if runtime::readable_schedule(&sc_readable) { let sc_transform = sc_transform.clone(); runtime::process_next_tick(Box::new(move || sc_transform_read_drain(sc_transform))); } }");
    this.context.line("fn sc_transform_start_flowing(sc_transform: &ScTransform) { let sc_readable = runtime::transform_readable(sc_transform); runtime::readable_start_flowing(&sc_readable); sc_transform_read_schedule(sc_transform); }");
  }

  private emitWriteHelpers(loc: SrcLoc): void {
    const arms: string[] = [];
    for (const shape of this.context.streams.transformCallbackShapes.values()) {
      const completion = this.completionType(shape.type, "Transform transform", loc);
      const completionShape = this.context.closureShapeForType(completion, loc);
      const params = completion.params.map((_, index) => `sc_arg_${index}`);
      const outputType = completion.params[1];
      const output = params[1] === undefined || outputType === undefined
        ? ""
        : this.emitOutput(params[1], outputType, "sc_transform", loc);
      const ignored = params.filter((_, index) => index !== 1);
      const ignore = ignored.length === 0 ? "" : `let _ = (${ignored.join(", ")});`;
      const done = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_transform = sc_transform.clone(); let sc_done = sc_done.clone(); let sc_called = std::rc::Rc::new(std::cell::Cell::new(false)); move |${params.join(", ")}| { ${ignore} if sc_called.replace(true) { return; } ${output} let sc_writable = runtime::transform_writable(&sc_transform); runtime::writable_complete_write(&sc_writable, sc_length); sc_transform_after_write(&sc_transform, sc_done.clone()); } })), trace: Some(std::rc::Rc::new({ let sc_transform = sc_transform.clone(); let sc_done = sc_done.clone(); move |tracer| { tracer.edge(&sc_transform); runtime::Trace::trace(&sc_done, tracer); } })) })`;
      const call = this.context.emitClosureDispatch("callback", shape.type, [
        "sc_transform.clone()", "sc_chunk.clone()", "runtime::string(\"buffer\")", done,
      ], loc);
      arms.push(`ScTransformCallback::${this.variant(shape)}(callback) => { let _ = ${call}; },`);
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
    return `{ ${this.bind(expr.args, values)} let _ = (${values[5]}, ${values[6]}, ${values[7]}); let sc_emitter = runtime::emitter_new::<ScEmitterListener>(); let sc_readable = runtime::readable_new::<ScEmitterListener, ScTransformRead>(${values[0]}, ${values[3]}, Option::<ScTransformRead>::None, Option::<ScTransformRead>::None); runtime::readable_set_emitter(&sc_readable, sc_emitter.clone()); let sc_writable = runtime::writable_new::<ScEmitterListener, ScTransformWrite, ScTransformFinal, ScTransformDone>(${values[1]}, ${values[2]}, ${values[3]}, Some(ScTransformWrite::Transform), Some(ScTransformFinal::Flush)); runtime::writable_set_emitter(&sc_writable, sc_emitter); let sc_duplex: ScTransformDuplex = runtime::duplex_new(sc_readable, sc_writable, ${values[4]}); runtime::transform_new(sc_duplex, ${transform}, ${flush}, ${passthrough}) }`;
  }

  private emitWrite(expr: RustLibCallExpr, stringChunk: boolean): string {
    const chunk = expr.args[1];
    if (chunk?.type.kind !== (stringChunk ? "string" : "bytes") || expr.type.kind !== "bool" ||
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
    return `{ ${this.bind(expr.args, values)} let sc_writable = runtime::transform_writable(&${values[0]}); let sc_result = runtime::writable_enqueue(&sc_writable, ${converted}, ${done}); sc_transform_drain_write(&${values[0]}); sc_result }`;
  }

  private emitEnd(expr: RustLibCallExpr): string {
    const flagsExpr = expr.args[1];
    if (flagsExpr?.kind !== "numLit" || expr.type.kind !== "object" ||
      (expr.type.className !== "%Transform" && expr.type.className !== "%PassThrough")) {
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
      write = `let _ = runtime::writable_enqueue(&sc_writable, ${converted}, ScTransformDone::Never); sc_transform_drain_write(&${values[0]});`;
      index += 1;
    }
    if (index !== expr.args.length) this.context.unsupported("Transform end arity", expr.loc);
    const finish = `let sc_finish: std::rc::Rc<dyn Fn()> = std::rc::Rc::new({ let sc_transform = ${values[0]}.clone(); move || { let sc_readable = runtime::transform_readable(&sc_transform); let _ = runtime::readable_push_null(&sc_readable); sc_transform_read_schedule(&sc_transform); let sc_writable = runtime::transform_writable(&sc_transform); if runtime::writable_take_prefinish(&sc_writable) { sc_transform_emit_void(&sc_transform, "prefinish"); } if runtime::writable_schedule_finish(&sc_writable) { let sc_transform = sc_transform.clone(); runtime::process_next_tick(Box::new(move || { let sc_writable = runtime::transform_writable(&sc_transform); runtime::writable_mark_finished(&sc_writable); sc_transform_emit_void(&sc_transform, "finish"); let sc_duplex = runtime::transform_duplex(&sc_transform); if runtime::duplex_take_close(&sc_duplex) { sc_transform_emit_void(&sc_transform, "close"); } })); } } });`;
    const trace = `let sc_finish_trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)> = std::rc::Rc::new({ let sc_transform = ${values[0]}.clone(); move |tracer| tracer.edge(&sc_transform) });`;
    return `{ ${this.bind(expr.args, values)} let sc_writable = runtime::transform_writable(&${values[0]}); runtime::writable_mark_ended(&sc_writable); ${write} ${finish} ${trace} sc_transform_call_flush(&${values[0]}, sc_finish, sc_finish_trace); ${values[0]} }`;
  }

  private emitPush(expr: RustLibCallExpr, stringChunk: boolean): string {
    const chunk = expr.args[1];
    if (expr.args.length !== 2 || chunk?.type.kind !== (stringChunk ? "string" : "bytes") || expr.type.kind !== "bool") {
      this.context.unsupported("Transform push shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const converted = stringChunk ? `runtime::buffer_from_string(&${values[1]}, &runtime::string("utf8"))` : values[1];
    return `{ ${this.bind(expr.args, values)} let sc_readable = runtime::transform_readable(&${values[0]}); let sc_result = runtime::readable_push(&sc_readable, ${converted}); if runtime::readable_is_flowing(&sc_readable) { if let Some(sc_chunk) = runtime::readable_pop(&sc_readable) { sc_transform_emit_data(&${values[0]}, sc_chunk); } } sc_result }`;
  }

  private emitPushNull(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    if (receiver === undefined || expr.args.length !== 1 || expr.type.kind !== "bool") {
      this.context.unsupported("Transform null push shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; let sc_result = runtime::readable_push_null(&runtime::transform_readable(&${value})); sc_transform_read_schedule(&${value}); sc_result }`;
  }

  private emitProp(expr: RustLibCallExpr): string {
    const name = expr.args[1];
    if (expr.args.length !== 2 || name?.type.kind !== "string" || (expr.type.kind !== "f64" && expr.type.kind !== "bool")) {
      this.context.unsupported("Transform property shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const result = expr.type.kind === "f64"
      ? `match ${values[1]}.as_ref() { "readableHighWaterMark" | "readableLength" => runtime::readable_prop(&runtime::transform_readable(&${values[0]}), &${values[1]}), _ => runtime::writable_number_prop(&runtime::transform_writable(&${values[0]}), &${values[1]}), }`
      : `match ${values[1]}.as_ref() { "allowHalfOpen" => runtime::duplex_allow_half_open(&runtime::transform_duplex(&${values[0]})), "readable" | "readableEnded" | "readableObjectMode" => runtime::readable_bool_prop(&runtime::transform_readable(&${values[0]}), &${values[1]}), _ => runtime::writable_bool_prop(&runtime::transform_writable(&${values[0]}), &${values[1]}), }`;
    return `{ ${this.bind(expr.args, values)} ${result} }`;
  }

  private emitCork(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    if (receiver === undefined || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("Transform cork shape", expr.loc);
    }
    return `runtime::writable_cork(&runtime::transform_writable(&(${this.context.emitExpr(receiver)})))`;
  }

  private emitUncork(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    if (receiver === undefined || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("Transform uncork shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; let sc_writable = runtime::transform_writable(&${value}); if runtime::writable_uncork(&sc_writable) { sc_transform_drain_write(&${value}); } }`;
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

  private bind(args: readonly IrExpr[], values: readonly string[]): string {
    return args.map((arg, index) => `let ${values[index]} = ${this.context.emitExpr(arg)};`).join(" ");
  }

  private isTransform(expr: IrExpr | undefined): boolean {
    return expr?.type.kind === "object" &&
      (expr.type.className === "%Transform" || expr.type.className === "%PassThrough");
  }

  private variant(shape: RustClosureShape): string {
    return `Closure${shape.index}`;
  }
}
