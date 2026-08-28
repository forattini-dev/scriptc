import type { IrExpr, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import type { IrFuncType, RustClosureShape } from "./model.js";
import type { RustStreamModel } from "./stream-model.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustStreamPromiseContext {
  readonly streams: RustStreamModel;
  closureName(shape: RustClosureShape): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  dynTypeName(): string;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  emitExpr(expr: IrExpr): string;
  line(value: string): void;
  nextTemporary(): string;
  popIndent(): void;
  pushIndent(): void;
  rustType(type: IrType, loc?: SrcLoc): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export class RustStreamPromiseEmitter {
  constructor(private readonly context: RustStreamPromiseContext) {}

  emitDefinitions(): void {
    if (!this.context.streams.usesStreamFinished) return;
    this.context.line("#[derive(Clone)]");
    this.context.line("enum ScStream {");
    this.context.pushIndent();
    if (this.context.streams.usesReadable) this.context.line("Readable(ScReadable),");
    if (this.context.streams.usesWritable) this.context.line("Writable(ScWritable),");
    if (this.context.streams.usesDuplex) this.context.line("Duplex(ScDuplex),");
    if (this.context.streams.usesTransform) this.context.line("Transform(ScTransform),");
    this.context.popIndent();
    this.context.line("}");
    this.emitStreamHelpers();
    this.emitFinishedHelper();
    if (this.context.streams.usesStreamPipeline) this.emitPipelineHelper();
    if (this.context.streams.usesStreamConsumers) this.emitConsumerHelpers();
  }

  emitFinished(expr: RustLibCallExpr): string {
    const stream = expr.args[0];
    if (expr.fn !== "sp.finished" || stream === undefined || expr.args.length !== 1 ||
      expr.type.kind !== "promise" || expr.type.inner.kind !== "void") {
      this.context.unsupported("stream/promises finished shape", expr.loc);
    }
    return `sc_stream_promise_finished(${this.streamValue(stream.type, this.context.emitExpr(stream), expr.loc)})`;
  }

  emitCallbackFinished(expr: RustLibCallExpr): string {
    const [stream, callback] = expr.args;
    const dynamic = expr.fn === "stream.finishedDyn";
    if (stream === undefined || callback === undefined || expr.args.length !== 2 ||
      expr.type.kind !== "func" || expr.type.params.length !== 0 || expr.type.ret.kind !== "void" ||
      (dynamic ? callback.type.kind !== "dyn" : callback.type.kind !== "func")) {
      this.context.unsupported(`${expr.fn} shape`, expr.loc);
    }
    const streamValue = this.context.nextTemporary();
    const callbackValue = this.context.nextTemporary();
    const callbackState = this.context.nextTemporary();
    const cleanupShape = this.context.closureShapeForType(expr.type, expr.loc);
    const watched = this.streamValue(stream.type, `${streamValue}.clone()`, expr.loc);
    let invoke: string;
    let traceCallback: string;
    if (callback.type.kind === "dyn") {
      const dyn = this.context.dynTypeName();
      invoke = `let sc_args = match sc_status { Some(sc_error) => vec![sc_dyn_error_box(&sc_error)], None => Vec::<${dyn}>::new(), }; let _ = sc_dyn_call(&${callbackState}.0, &sc_args, "callback");`;
      traceCallback = `runtime::Trace::trace(&${callbackState}.0, tracer);`;
    } else {
      if (callback.type.kind !== "func") this.context.unsupported("stream.finished callback type", expr.loc);
      const callbackType = callback.type;
      if (callbackType.ret.kind !== "void" || callbackType.rest === true ||
        callbackType.params.length < 1 || callbackType.params.length > 2) {
        this.context.unsupported("stream.finished callback signature", expr.loc);
      }
      const first = callbackType.params[0];
      if (first?.kind !== "object" || stream.type.kind !== "object" || first.className !== stream.type.className) {
        this.context.unsupported("stream.finished callback receiver", expr.loc);
      }
      const args = ["sc_target.clone()"];
      const statusType = callbackType.params[1];
      if (statusType !== undefined) args.push(this.finishedStatus(statusType, "sc_status", expr.loc));
      invoke = `let _ = ${this.context.emitClosureDispatch(`${callbackState}.0`, callbackType, args, expr.loc)};`;
      traceCallback = `tracer.edge(&${callbackState}.0);`;
    }
    return `{ let ${streamValue} = ${this.context.emitExpr(stream)}; let ${callbackValue} = ${this.context.emitExpr(callback)}; let ${callbackState} = std::rc::Rc::new((${callbackValue}, ${streamValue}.downgrade())); let (sc_cleanup, sc_cleanup_trace) = sc_stream_finished(${watched}, std::rc::Rc::new({ let ${callbackState} = ${callbackState}.clone(); move |_, sc_status| { let sc_target = ${callbackState}.1.upgrade().expect("scriptc: finished callback lost its live stream"); ${invoke} } }), std::rc::Rc::new(move |tracer| { ${traceCallback} })); runtime::Gc::new(${this.context.closureName(cleanupShape)}::RuntimeCallback { callback: Some(sc_cleanup), trace: Some(sc_cleanup_trace) }) }`;
  }

  emitConsumer(expr: RustLibCallExpr): string {
    const stream = expr.args[0];
    if (stream === undefined || expr.args.length !== 1 || expr.type.kind !== "promise") {
      this.context.unsupported("stream consumer shape", expr.loc);
    }
    const expected = expr.fn === "sc.text" ? "string" : expr.fn === "sc.json" ? "dyn" : "bytes";
    if (expr.type.inner.kind !== expected) this.context.unsupported("stream consumer result", expr.loc);
    const value = this.streamValue(stream.type, this.context.emitExpr(stream), expr.loc);
    const helper = expr.fn === "sc.text" ? "text" : expr.fn === "sc.json" ? "json" : "buffer";
    return `sc_stream_consume_${helper}(${value})`;
  }

  streamValue(type: IrType, value: string, loc: SrcLoc): string {
    if (type.kind !== "object") this.context.unsupported("non-object stream value", loc);
    switch (type.className) {
      case "%Readable": return `ScStream::Readable(${value})`;
      case "%Writable": return `ScStream::Writable(${value})`;
      case "%Duplex": return `ScStream::Duplex(${value})`;
      case "%Transform":
      case "%PassThrough": return `ScStream::Transform(${value})`;
      default: return this.context.unsupported(`unsupported stream class '${type.className}'`, loc);
    }
  }

  callbackStatus(type: IrType, value: string, loc: SrcLoc): string {
    return this.finishedStatus(type, value, loc);
  }

  private emitStreamHelpers(): void {
    this.context.line("fn sc_stream_identity(stream: &ScStream) -> usize { match stream {");
    this.context.pushIndent();
    for (const variant of this.variants()) this.context.line(`ScStream::${variant}(value) => value.identity(),`);
    this.context.popIndent();
    this.context.line("} }");
    this.context.line("fn sc_stream_weak(stream: &ScStream) -> std::rc::Rc<dyn Fn() -> Option<ScStream>> { match stream {");
    this.context.pushIndent();
    for (const variant of this.variants()) this.context.line(`ScStream::${variant}(value) => { let weak = value.downgrade(); std::rc::Rc::new(move || weak.upgrade().map(ScStream::${variant})) },`);
    this.context.popIndent();
    this.context.line("} }");
    this.context.line("fn sc_stream_trace(stream: &ScStream, tracer: &mut runtime::Tracer<'_>) { match stream {");
    this.context.pushIndent();
    for (const variant of this.variants()) this.context.line(`ScStream::${variant}(value) => tracer.edge(value),`);
    this.context.popIndent();
    this.context.line("} }");
    this.context.line("fn sc_stream_emitter(stream: &ScStream) -> ScEmitterRegistry { match stream {");
    this.context.pushIndent();
    if (this.context.streams.usesReadable) this.context.line("ScStream::Readable(value) => runtime::readable_emitter(value),");
    if (this.context.streams.usesWritable) this.context.line("ScStream::Writable(value) => runtime::writable_emitter(value),");
    if (this.context.streams.usesDuplex) this.context.line("ScStream::Duplex(value) => runtime::duplex_emitter(value),");
    if (this.context.streams.usesTransform) this.context.line("ScStream::Transform(value) => runtime::transform_emitter(value),");
    this.context.popIndent();
    this.context.line("} }");
    this.context.line("fn sc_stream_finish_status(stream: &ScStream) -> Option<runtime::JsError> { match stream {");
    this.context.pushIndent();
    if (this.context.streams.usesReadable) this.context.line("ScStream::Readable(value) => runtime::readable_error(value).or_else(|| (!runtime::readable_bool_prop(value, &runtime::string(\"readableEnded\"))).then(|| runtime::error_new_code(\"Error\", runtime::string(\"Premature close\"), \"ERR_STREAM_PREMATURE_CLOSE\"))),");
    if (this.context.streams.usesWritable) this.context.line("ScStream::Writable(value) => runtime::writable_error(value).or_else(|| (!runtime::writable_bool_prop(value, &runtime::string(\"writableFinished\"))).then(|| runtime::error_new_code(\"Error\", runtime::string(\"Premature close\"), \"ERR_STREAM_PREMATURE_CLOSE\"))),");
    if (this.context.streams.usesDuplex) this.context.line("ScStream::Duplex(value) => { let readable = runtime::duplex_readable(value); let writable = runtime::duplex_writable(value); runtime::readable_error(&readable).or_else(|| runtime::writable_error(&writable)).or_else(|| (!(runtime::readable_bool_prop(&readable, &runtime::string(\"readableEnded\")) && runtime::writable_bool_prop(&writable, &runtime::string(\"writableFinished\")))).then(|| runtime::error_new_code(\"Error\", runtime::string(\"Premature close\"), \"ERR_STREAM_PREMATURE_CLOSE\"))) },");
    if (this.context.streams.usesTransform) this.context.line("ScStream::Transform(value) => { let readable = runtime::transform_readable(value); let writable = runtime::transform_writable(value); runtime::readable_error(&readable).or_else(|| runtime::writable_error(&writable)).or_else(|| (!(runtime::readable_bool_prop(&readable, &runtime::string(\"readableEnded\")) && runtime::writable_bool_prop(&writable, &runtime::string(\"writableFinished\")))).then(|| runtime::error_new_code(\"Error\", runtime::string(\"Premature close\"), \"ERR_STREAM_PREMATURE_CLOSE\"))) },");
    this.context.popIndent();
    this.context.line("} }");
    if (!this.context.streams.usesStreamPipeline) return;
    this.context.line("fn sc_stream_destroy(stream: &ScStream, error: runtime::JsError) { match stream {");
    this.context.pushIndent();
    if (this.context.streams.usesReadable) this.context.line("ScStream::Readable(value) => { if runtime::readable_destroy(value, Some(error.clone())) { sc_readable_finish_destroy(value, Some(error)); } },");
    if (this.context.streams.usesWritable) this.context.line("ScStream::Writable(value) => { if runtime::writable_destroy(value, Some(error.clone())) { sc_writable_finish_destroy(value, Some(error)); } },");
    if (this.context.streams.usesDuplex) this.context.line("ScStream::Duplex(value) => sc_duplex_destroy_pipeline(value, error),");
    if (this.context.streams.usesTransform) this.context.line("ScStream::Transform(value) => sc_transform_destroy_pipeline(value, error),");
    this.context.popIndent();
    this.context.line("} }");
  }

  private emitFinishedHelper(): void {
    this.context.line("fn sc_stream_finished(stream: ScStream, callback: std::rc::Rc<dyn Fn(ScStream, Option<runtime::JsError>)>, trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>) -> (std::rc::Rc<dyn Fn()>, std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>) {");
    this.context.pushIndent();
    this.context.line("let emitter = sc_stream_emitter(&stream);");
    this.context.line("let active = std::rc::Rc::new(std::cell::Cell::new(true));");
    this.context.line("let stream_weak = sc_stream_weak(&stream);");
    this.context.line("let emitter_weak: std::rc::Rc<dyn Fn() -> Option<ScEmitterRegistry>> = { let weak = emitter.downgrade(); std::rc::Rc::new(move || weak.upgrade()) };");
    this.context.line("let state = std::rc::Rc::new((stream_weak, emitter_weak, std::cell::RefCell::new(Option::<runtime::JsError>::None), active.clone(), callback, trace));");
    this.context.line("let identity = std::rc::Rc::as_ptr(&state) as usize;");
    this.context.line("runtime::emitter_on(&emitter, runtime::string(\"error\"), ScEmitterListener::RuntimeError(std::rc::Rc::new({ let state = state.clone(); move |value| { if state.2.borrow().is_none() { *state.2.borrow_mut() = Some(value); } } }), std::rc::Rc::new({ let state = state.clone(); move |tracer| { if let Some(value) = state.2.borrow().as_ref() { runtime::Trace::trace(value, tracer); } (state.5)(tracer); } })), identity, true, false);");
    this.context.line("runtime::emitter_on(&emitter, runtime::string(\"close\"), ScEmitterListener::RuntimeVoid(std::rc::Rc::new({ let state = state.clone(); move || { if !state.3.replace(false) { return; } if let Some(emitter) = (state.1)() { let _ = runtime::emitter_off(&emitter, &runtime::string(\"error\"), identity); } let Some(stream) = (state.0)() else { return; }; let status = state.2.borrow().clone().or_else(|| sc_stream_finish_status(&stream)); (state.4)(stream, status); } }), std::rc::Rc::new({ let state = state.clone(); move |tracer| { if let Some(value) = state.2.borrow().as_ref() { runtime::Trace::trace(value, tracer); } (state.5)(tracer); } })), identity, true, false);");
    this.context.line("let retained = std::rc::Rc::new((stream, active));");
    this.context.line("let cleanup: std::rc::Rc<dyn Fn()> = std::rc::Rc::new({ let retained = retained.clone(); move || { if !retained.1.replace(false) { return; } let emitter = sc_stream_emitter(&retained.0); let _ = runtime::emitter_off(&emitter, &runtime::string(\"error\"), identity); let _ = runtime::emitter_off(&emitter, &runtime::string(\"close\"), identity); } });");
    this.context.line("let cleanup_trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)> = std::rc::Rc::new(move |tracer| sc_stream_trace(&retained.0, tracer));");
    this.context.line("(cleanup, cleanup_trace)");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_stream_promise_finished(stream: ScStream) -> runtime::JsPromise<()> { let promise = runtime::promise_new::<()>(); let target = promise.clone(); let traced = promise.clone(); let _ = sc_stream_finished(stream, std::rc::Rc::new(move |_, error| { if let Some(error) = error { let _ = runtime::promise_reject(&target, runtime::caught_value(error)); } else { let _ = runtime::promise_fulfill(&target, ()); } }), std::rc::Rc::new(move |tracer| tracer.edge(&traced))); promise }");
  }

  private emitPipelineHelper(): void {
    this.context.line("struct ScStreamPipeline { streams: Vec<ScStream>, closed: usize, error: Option<runtime::JsError>, callback: std::rc::Rc<dyn Fn(Option<runtime::JsError>)>, trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)> }");
    this.context.line("fn sc_stream_callback_pipeline(streams: Vec<ScStream>, callback: std::rc::Rc<dyn Fn(Option<runtime::JsError>)>, trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>) {");
    this.context.pushIndent();
    this.context.line("let pipeline = std::rc::Rc::new(std::cell::RefCell::new(ScStreamPipeline { streams, closed: 0, error: None, callback, trace }));");
    this.context.line("let watched = pipeline.borrow().streams.clone();");
    this.context.line("for stream in watched { let pipeline_callback = pipeline.clone(); let pipeline_trace = pipeline.clone(); let _ = sc_stream_finished(stream, std::rc::Rc::new(move |closed_stream, status| { let mut state = pipeline_callback.borrow_mut(); state.closed += 1; let destroy = if state.error.is_none() { status.map(|error| { state.error = Some(error.clone()); (error, state.streams.clone()) }) } else { None }; let settle = (state.closed == state.streams.len()).then(|| (state.callback.clone(), state.error.clone())); drop(state); if let Some((error, streams)) = destroy { let closed_identity = sc_stream_identity(&closed_stream); for stream in streams { if sc_stream_identity(&stream) != closed_identity { sc_stream_destroy(&stream, error.clone()); } } } if let Some((callback, error)) = settle { callback(error); } }), std::rc::Rc::new(move |tracer| { let state = pipeline_trace.borrow(); (state.trace)(tracer); for stream in &state.streams { sc_stream_trace(stream, tracer); } })); }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_stream_promise_pipeline(streams: Vec<ScStream>) -> runtime::JsPromise<()> {");
    this.context.pushIndent();
    this.context.line("let promise = runtime::promise_new::<()>();");
    this.context.line("let target = promise.clone();");
    this.context.line("let traced = promise.clone();");
    this.context.line("sc_stream_callback_pipeline(streams, std::rc::Rc::new(move |error| { if let Some(error) = error { let _ = runtime::promise_reject(&target, runtime::caught_value(error)); } else { let _ = runtime::promise_fulfill(&target, ()); } }), std::rc::Rc::new(move |tracer| tracer.edge(&traced)));");
    this.context.line("promise");
    this.context.popIndent();
    this.context.line("}");
  }

  private emitConsumerHelpers(): void {
    this.context.line("fn sc_stream_resume_consumer(stream: &ScStream) { match stream {");
    this.context.pushIndent();
    if (this.context.streams.usesReadable) this.context.line("ScStream::Readable(value) => { runtime::readable_resume(value); sc_readable_schedule(value); },");
    if (this.context.streams.usesWritable) this.context.line("ScStream::Writable(_) => runtime::throw_type_error(\"stream is not async iterable\".to_owned()),");
    if (this.context.streams.usesDuplex) this.context.line("ScStream::Duplex(value) => { let readable = runtime::duplex_readable(value); runtime::readable_resume(&readable); sc_duplex_read_schedule(value); },");
    if (this.context.streams.usesTransform) this.context.line("ScStream::Transform(value) => { let readable = runtime::transform_readable(value); runtime::readable_resume(&readable); sc_transform_read_schedule(value); },");
    this.context.popIndent();
    this.context.line("} }");
    this.context.line("fn sc_stream_consume<T: runtime::HeapValue>(stream: ScStream, convert: std::rc::Rc<dyn Fn(Vec<runtime::JsBytes<u8>>) -> T>) -> runtime::JsPromise<T> {");
    this.context.pushIndent();
    this.context.line("let promise = runtime::promise_new::<T>();");
    this.context.line("let chunks = std::rc::Rc::new(std::cell::RefCell::new(Vec::<runtime::JsBytes<u8>>::new()));");
    this.context.line("let identity = std::rc::Rc::as_ptr(&chunks) as usize;");
    this.context.line("let emitter = sc_stream_emitter(&stream);");
    this.context.line("let target = promise.clone();");
    this.context.line("let target_trace = promise.clone();");
    this.context.line("let finish_chunks = chunks.clone();");
    this.context.line("let finish_chunks_trace = chunks.clone();");
    this.context.line("let finish_emitter = emitter.clone();");
    this.context.line("sc_stream_finished(stream.clone(), std::rc::Rc::new(move |_, error| { let _ = runtime::emitter_off(&finish_emitter, &runtime::string(\"data\"), identity); if let Some(error) = error { let _ = runtime::promise_reject(&target, runtime::caught_value(error)); return; } let values = std::mem::take(&mut *finish_chunks.borrow_mut()); let guard = target.clone(); runtime::promise_run_segment(&guard, || { let value = convert(values); let _ = runtime::promise_fulfill(&target, value); }); }), std::rc::Rc::new(move |tracer| { tracer.edge(&target_trace); for chunk in finish_chunks_trace.borrow().iter() { tracer.edge(chunk); } }));");
    this.context.line("runtime::emitter_on(&emitter, runtime::string(\"data\"), ScEmitterListener::RuntimeData(std::rc::Rc::new({ let chunks = chunks.clone(); move |bytes, text| { if let Some(bytes) = bytes { chunks.borrow_mut().push(bytes); } else if let Some(text) = text { chunks.borrow_mut().push(runtime::buffer_from_string(&text, &runtime::string(\"utf8\"))); } } }), std::rc::Rc::new(move |tracer| { for chunk in chunks.borrow().iter() { tracer.edge(chunk); } })), identity, false, false);");
    this.context.line("sc_stream_resume_consumer(&stream);");
    this.context.line("promise");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_stream_consume_bytes(chunks: Vec<runtime::JsBytes<u8>>) -> runtime::JsBytes<u8> { runtime::buffer_concat(&runtime::array_new(chunks)) }");
    this.context.line("fn sc_stream_consume_text(stream: ScStream) -> runtime::JsPromise<runtime::JsString> { sc_stream_consume(stream, std::rc::Rc::new(|chunks| runtime::bytes_to_string(&sc_stream_consume_bytes(chunks), &runtime::string(\"utf8\")))) }");
    this.context.line(`fn sc_stream_consume_json(stream: ScStream) -> runtime::JsPromise<${this.context.dynTypeName()}> { sc_stream_consume(stream, std::rc::Rc::new(|chunks| runtime::json_parse_typed::<${this.context.dynTypeName()}>(&runtime::bytes_to_string(&sc_stream_consume_bytes(chunks), &runtime::string("utf8"))))) }`);
    this.context.line("fn sc_stream_consume_buffer(stream: ScStream) -> runtime::JsPromise<runtime::JsBytes<u8>> { sc_stream_consume(stream, std::rc::Rc::new(sc_stream_consume_bytes)) }");
  }

  private variants(): string[] {
    return [
      this.context.streams.usesReadable ? "Readable" : null,
      this.context.streams.usesWritable ? "Writable" : null,
      this.context.streams.usesDuplex ? "Duplex" : null,
      this.context.streams.usesTransform ? "Transform" : null,
    ].filter((value): value is string => value !== null);
  }

  private finishedStatus(type: IrType, value: string, loc: SrcLoc): string {
    if (type.kind === "dyn") {
      const dyn = this.context.dynTypeName();
      return `match ${value} { Some(sc_error) => sc_dyn_error_box(&sc_error), None => ${dyn}::Undefined }`;
    }
    if (type.kind !== "union") this.context.unsupported("stream.finished error parameter", loc);
    const union = this.context.union(type.unionId, loc);
    const errorTag = union.arms.findIndex((arm) => arm.kind === "object" && arm.className === "%Error");
    const cleanTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
    const fallbackCleanTag = union.arms.findIndex((arm) => arm.kind === "nullT");
    const successTag = cleanTag >= 0 ? cleanTag : fallbackCleanTag;
    if (errorTag < 0 || successTag < 0) this.context.unsupported("stream.finished error union", loc);
    const name = this.context.unionName(union.id);
    const errorType = this.context.rustType({ kind: "object", className: "%Error" }, loc);
    const error = errorType === "runtime::JsError" ? "sc_error" : `${errorType}::Builtin(sc_error)`;
    return `match ${value} { Some(sc_error) => ${name}::${this.context.unionVariant(errorTag)}(${error}), None => ${name}::${this.context.unionVariant(successTag)}, }`;
  }
}
