import type { IrExpr, IrType, SrcLoc } from "../../ir/nodes.js";
import type { RustStreamModel } from "./stream-model.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustStreamPromiseContext {
  readonly streams: RustStreamModel;
  dynTypeName(): string;
  emitExpr(expr: IrExpr): string;
  line(value: string): void;
  nextTemporary(): string;
  popIndent(): void;
  pushIndent(): void;
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

  private emitStreamHelpers(): void {
    this.context.line("fn sc_stream_identity(stream: &ScStream) -> usize { match stream {");
    this.context.pushIndent();
    for (const variant of this.variants()) this.context.line(`ScStream::${variant}(value) => value.identity(),`);
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
    this.context.line("fn sc_stream_finished(stream: ScStream, callback: std::rc::Rc<dyn Fn(ScStream, Option<runtime::JsError>)>, trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>) {");
    this.context.pushIndent();
    this.context.line("let emitter = sc_stream_emitter(&stream);");
    this.context.line("let error = std::rc::Rc::new(std::cell::RefCell::new(Option::<runtime::JsError>::None));");
    this.context.line("let error_identity = std::rc::Rc::as_ptr(&error) as usize;");
    this.context.line("runtime::emitter_on(&emitter, runtime::string(\"error\"), ScEmitterListener::RuntimeError(std::rc::Rc::new({ let error = error.clone(); move |value| { if error.borrow().is_none() { *error.borrow_mut() = Some(value); } } }), std::rc::Rc::new(|_| {})), error_identity, true, false);");
    this.context.line("runtime::emitter_on(&emitter, runtime::string(\"close\"), ScEmitterListener::RuntimeVoid(std::rc::Rc::new({ let emitter = emitter.clone(); let stream = stream.clone(); let error = error.clone(); move || { let _ = runtime::emitter_off(&emitter, &runtime::string(\"error\"), error_identity); let status = error.borrow().clone().or_else(|| sc_stream_finish_status(&stream)); callback(stream.clone(), status); } }), std::rc::Rc::new({ let stream = stream.clone(); move |tracer| { sc_stream_trace(&stream, tracer); trace(tracer); } })), error_identity, true, false);");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_stream_promise_finished(stream: ScStream) -> runtime::JsPromise<()> { let promise = runtime::promise_new::<()>(); let target = promise.clone(); let traced = promise.clone(); sc_stream_finished(stream, std::rc::Rc::new(move |_, error| { if let Some(error) = error { let _ = runtime::promise_reject(&target, runtime::caught_value(error)); } else { let _ = runtime::promise_fulfill(&target, ()); } }), std::rc::Rc::new(move |tracer| tracer.edge(&traced))); promise }");
  }

  private emitPipelineHelper(): void {
    this.context.line("struct ScStreamPipeline { streams: Vec<ScStream>, closed: usize, error: Option<runtime::JsError>, promise: runtime::JsPromise<()> }");
    this.context.line("fn sc_stream_promise_pipeline(streams: Vec<ScStream>) -> runtime::JsPromise<()> {");
    this.context.pushIndent();
    this.context.line("let promise = runtime::promise_new::<()>();");
    this.context.line("let pipeline = std::rc::Rc::new(std::cell::RefCell::new(ScStreamPipeline { streams, closed: 0, error: None, promise: promise.clone() }));");
    this.context.line("let watched = pipeline.borrow().streams.clone();");
    this.context.line("for stream in watched { let pipeline_callback = pipeline.clone(); let pipeline_trace = pipeline.clone(); sc_stream_finished(stream, std::rc::Rc::new(move |closed_stream, status| { let mut state = pipeline_callback.borrow_mut(); state.closed += 1; let destroy = if state.error.is_none() { status.map(|error| { state.error = Some(error.clone()); (error, state.streams.clone()) }) } else { None }; let settle = (state.closed == state.streams.len()).then(|| (state.promise.clone(), state.error.clone())); drop(state); if let Some((error, streams)) = destroy { let closed_identity = sc_stream_identity(&closed_stream); for stream in streams { if sc_stream_identity(&stream) != closed_identity { sc_stream_destroy(&stream, error.clone()); } } } if let Some((promise, error)) = settle { if let Some(error) = error { let _ = runtime::promise_reject(&promise, runtime::caught_value(error)); } else { let _ = runtime::promise_fulfill(&promise, ()); } } }), std::rc::Rc::new(move |tracer| { let state = pipeline_trace.borrow(); tracer.edge(&state.promise); for stream in &state.streams { sc_stream_trace(stream, tracer); } })); }");
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
}
