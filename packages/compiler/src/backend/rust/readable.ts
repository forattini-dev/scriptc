import type { IrExpr, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import type { IrFuncType, RustClosureShape } from "./model.js";
import type { RustStreamModel } from "./stream-model.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustReadableContext {
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
  rustType(type: IrType, loc?: SrcLoc): string;
  runtimeStreamBase(name: string): "%Readable" | "%Writable" | "%Duplex" | "%Transform" | null;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit the module-specialized Readable object and its typed event bridge. */
export class RustReadableEmitter {
  constructor(private readonly context: RustReadableContext) {}

  emitTypeDefinition(): void {
    if (!this.context.streams.usesReadable) return;
    this.context.line("#[derive(Clone)]");
    this.context.line("enum ScReadableRead {");
    this.context.pushIndent();
    this.context.line("Never,");
    if (this.context.streams.usesReadableSubclass) {
      this.context.line("RuntimeRead(std::rc::Rc<dyn Fn(f64)>, std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>),");
    }
    for (const shape of this.callbackShapes()) {
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
    if (this.context.streams.usesReadableSubclass) {
      this.context.line("Self::RuntimeRead(_, trace) => trace(tracer),");
    }
    for (const shape of this.callbackShapes()) {
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
    if (!this.context.streams.usesReadable) return;
    const loc = this.context.sourceLoc();
    const byteArms: string[] = [];
    const stringArms: string[] = [];
    const voidArms: string[] = [];
    const errorArms: string[] = [];
    const readArms: string[] = [];
    for (const shape of this.context.listenerShapes.values()) {
      if (shape.type.rest === true) continue;
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "bytes") {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_chunk.clone()"], loc);
        byteArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "dyn") {
        const chunk = `${this.context.dynTypeName()}::Buffer(sc_chunk.clone())`;
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, [chunk], loc);
        byteArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
        const text = `${this.context.dynTypeName()}::String(sc_chunk.clone())`;
        const stringDispatch = this.context.emitClosureDispatch("callback", shape.type, [text], loc);
        stringArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${stringDispatch}; },`);
      }
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "string") {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_chunk.clone()"], loc);
        stringArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
      if (shape.type.params.length === 0) {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, [], loc);
        byteArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
        stringArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
        voidArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
        errorArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "object" &&
        shape.type.params[0].className === "%Error") {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_error.clone()"], loc);
        errorArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
    }
    for (const shape of this.context.streams.readableReadShapes.values()) {
      if (shape.type.rest === true) continue;
      const [first, second] = shape.type.params;
      const readSize = "runtime::readable_prop(sc_readable, &runtime::string(\"readableHighWaterMark\"))";
      let args: string[] | null = null;
      if (shape.type.params.length === 1 && first?.kind === "object" && first.className === "%Readable") {
        args = ["sc_readable.clone()"];
      } else if (shape.type.params.length === 1 && first?.kind === "dyn") {
        args = [`${this.context.dynTypeName()}::Number(${readSize})`];
      } else if (shape.type.params.length === 2 && first?.kind === "object" &&
        first.className === "%Readable" && (second?.kind === "f64" || second?.kind === "dyn")) {
        args = ["sc_readable.clone()", second.kind === "dyn"
          ? `${this.context.dynTypeName()}::Number(${readSize})`
          : readSize];
      }
      if (args === null) continue;
      const dispatch = this.context.emitClosureDispatch("callback", shape.type, args, loc);
      readArms.push(`ScReadableRead::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
    }
    if (this.context.streams.usesStreamFinished) {
      voidArms.push("ScEmitterListener::RuntimeVoid(callback, _) => callback(),");
      errorArms.push("ScEmitterListener::RuntimeError(callback, _) => callback(sc_error.clone()),");
    }
    if (this.context.streams.usesStreamConsumers) {
      byteArms.push("ScEmitterListener::RuntimeData(callback, _) => callback(Some(sc_chunk.clone()), None),");
      stringArms.push("ScEmitterListener::RuntimeData(callback, _) => callback(None, Some(sc_chunk.clone())),");
    }
    byteArms.push("_ => unreachable!(\"scriptc invariant: Readable data listener signature\"),");
    stringArms.push("_ => unreachable!(\"scriptc invariant: Readable string data listener signature\"),");
    voidArms.push("_ => unreachable!(\"scriptc invariant: Readable lifecycle listener signature\"),");
    errorArms.push("_ => unreachable!(\"scriptc invariant: Readable error listener signature\"),");
    readArms.push("ScReadableRead::Never => {},");
    if (this.context.streams.usesReadableSubclass) {
      readArms.push("ScReadableRead::RuntimeRead(callback, _) => callback(runtime::readable_prop(sc_readable, &runtime::string(\"readableHighWaterMark\"))),");
    }
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
    this.context.line("runtime::readable_write_pipes(sc_readable, sc_chunk);");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_readable_emit_string(sc_readable: &ScReadable, sc_chunk: runtime::JsString) {");
    this.context.pushIndent();
    this.context.line("let sc_emitter = runtime::readable_emitter(sc_readable);");
    this.context.line("let sc_name = runtime::string(\"data\");");
    this.context.line("let sc_snapshot = runtime::emitter_snapshot(&sc_emitter, &sc_name);");
    this.context.line("for sc_registration in sc_snapshot { if !runtime::emitter_listener_should_invoke(&sc_registration) { continue; } if sc_registration.once { let _ = runtime::emitter_remove_registration(&sc_emitter, &sc_name, sc_registration.registration); } match sc_registration.callback {");
    this.context.pushIndent();
    for (const arm of stringArms) this.context.line(arm);
    this.context.popIndent();
    this.context.line("} }");
    this.context.line("runtime::readable_write_pipes(sc_readable, runtime::buffer_from_string(&sc_chunk, &runtime::string(\"utf8\")));");
    this.context.popIndent();
    this.context.line("}");
    if (this.context.streams.usesReadableDestroy) {
      this.context.line(`fn sc_readable_emit_error(sc_readable: &ScReadable, sc_error: ${this.standardErrorType(loc)}) {`);
      this.context.pushIndent();
      this.context.line("let sc_emitter = runtime::readable_emitter(sc_readable);");
      this.context.line("let sc_name = runtime::string(\"error\");");
      this.context.line("let sc_snapshot = runtime::emitter_snapshot(&sc_emitter, &sc_name);");
      this.context.line("if sc_snapshot.is_empty() && !runtime::readable_has_async_iterator(sc_readable) { runtime::throw_value(sc_error); }");
      this.context.line("for sc_registration in sc_snapshot { if !runtime::emitter_listener_should_invoke(&sc_registration) { continue; } if sc_registration.once { let _ = runtime::emitter_remove_registration(&sc_emitter, &sc_name, sc_registration.registration); } match sc_registration.callback {");
      this.context.pushIndent();
      for (const arm of errorArms) this.context.line(arm);
      this.context.popIndent();
      this.context.line("} }");
      this.context.popIndent();
      this.context.line("}");
    }
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
    if (this.context.streams.usesReadableDestroy) {
      const errorType = this.standardErrorType(loc);
      this.context.line(`fn sc_readable_finish_destroy(sc_readable: &ScReadable, sc_error: Option<${errorType}>) { if let Some(sc_error) = sc_error { let sc_readable = sc_readable.clone(); runtime::process_next_tick(Box::new(move || sc_readable_emit_error(&sc_readable, sc_error))); } let sc_readable = sc_readable.clone(); runtime::process_next_tick(Box::new(move || { if runtime::readable_take_destroy_close(&sc_readable) { sc_readable_emit_void(&sc_readable, "close"); } })); }`);
    }
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
    this.context.line("fn sc_readable_finish_end(sc_readable: &ScReadable) {");
    this.context.pushIndent();
    this.context.line("sc_readable_emit_void(sc_readable, \"end\");");
    this.context.line("runtime::readable_end_pipes(sc_readable);");
    this.context.line("let sc_readable = sc_readable.clone();");
    this.context.line("runtime::process_next_tick(Box::new(move || { if runtime::readable_take_close(&sc_readable) { sc_readable_emit_void(&sc_readable, \"close\"); } }));");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_readable_drain(sc_readable: ScReadable) {");
    this.context.pushIndent();
    this.context.line("runtime::readable_begin_drain(&sc_readable);");
    this.context.line("if runtime::readable_take_resume(&sc_readable, false) { sc_readable_emit_void(&sc_readable, \"resume\"); }");
    this.context.line("let mut sc_emitted_data = false;");
    this.context.line("let mut sc_called_read = false;");
    this.context.line("loop {");
    this.context.pushIndent();
    this.context.line("while runtime::readable_is_flowing(&sc_readable) { let Some(sc_chunk) = runtime::readable_pop(&sc_readable) else { break; }; sc_emitted_data = true; match sc_chunk { runtime::ReadableChunk::Bytes(value) => sc_readable_emit_data(&sc_readable, value), runtime::ReadableChunk::String(value) => sc_readable_emit_string(&sc_readable, value), } if runtime::readable_take_resume(&sc_readable, true) { sc_readable_emit_void(&sc_readable, \"resume\"); } }");
    this.context.line("if !runtime::readable_is_flowing(&sc_readable) { runtime::readable_end_drain(&sc_readable); return; }");
    this.context.line("if runtime::readable_take_push_after_eof(&sc_readable) { runtime::throw_error_code(\"stream.push() after EOF\".to_owned(), \"ERR_STREAM_PUSH_AFTER_EOF\"); }");
    this.context.line("if (sc_emitted_data || sc_called_read) && runtime::readable_has_data_or_eof(&sc_readable) { runtime::readable_end_drain(&sc_readable); sc_readable_schedule(&sc_readable); return; }");
    this.context.line("if runtime::readable_take_end(&sc_readable) { sc_readable_finish_end(&sc_readable); runtime::readable_end_drain(&sc_readable); return; }");
    this.context.line("sc_readable_call_read(&sc_readable);");
    this.context.line("sc_called_read = true;");
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
    this.context.line("runtime::process_next_tick(Box::new(move || { runtime::readable_begin_notification(&sc_readable); sc_readable_emit_void(&sc_readable, \"readable\"); runtime::readable_end_notification(&sc_readable); if runtime::readable_take_end(&sc_readable) { let sc_readable = sc_readable.clone(); runtime::process_next_tick(Box::new(move || sc_readable_finish_end(&sc_readable))); } }));");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("");
  }

  emitLibCall(expr: RustLibCallExpr): string | null {
    switch (expr.fn) {
      case "readable.new": return this.emitNew(expr);
      case "readable.init": return this.emitInit(expr);
      case "readable.fromArr": return this.emitFromArray(expr);
      case "readable.nextChunkDyn": return this.emitNextChunkDynamic(expr);
      case "readable.push": return this.emitPush(expr, false);
      case "readable.pushStr": return this.emitPush(expr, true);
      case "readable.pushStrEnc": return this.emitPushStringEncoding(expr);
      case "readable.pushEncoding": return this.emitPushEncoding(expr);
      case "readable.setEncoding": return this.emitSetEncoding(expr);
      case "readable.pushU": return this.emitPushUnion(expr);
      case "readable.pushNull": return this.emitPushNull(expr);
      case "readable.read": return this.emitRead(expr);
      case "readable.unshift": return this.emitUnshift(expr);
      case "readable.pause": return this.emitPause(expr);
      case "readable.resume": return this.emitResume(expr);
      case "readable.isPaused": return this.emitIsPaused(expr);
      case "readable.flowing": return this.emitFlowing(expr);
      case "stream.setRead": return this.isReadable(expr.args[0]) ? this.emitSetRead(expr) : null;
      case "stream.prop": return this.isReadable(expr.args[0]) ? this.emitProp(expr) : null;
      case "stream.destroy": return this.isReadable(expr.args[0]) ? this.emitDestroy(expr, false) : null;
      case "stream.destroyErr": return this.isReadable(expr.args[0]) ? this.emitDestroy(expr, true) : null;
      case "stream.errored": return this.isReadable(expr.args[0]) ? this.emitErrored(expr) : null;
      default: return null;
    }
  }

  private emitNew(expr: RustLibCallExpr): string {
    const [highWaterMark, autoDestroy, emitClose, flagsExpr] = expr.args;
    if (highWaterMark?.type.kind !== "f64" || autoDestroy?.type.kind !== "bool" ||
      emitClose?.type.kind !== "bool" || flagsExpr?.kind !== "numLit" ||
      expr.type.kind !== "object" || expr.type.className !== "%Readable") {
      this.context.unsupported("Readable constructor shape", expr.loc);
    }
    const flags = flagsExpr.value;
    if ((flags & ~3) !== 0) this.context.unsupported("Readable constructor callback set", expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    let callbackIndex = 4;
    let read = "Option::<ScReadableRead>::None";
    let destroy = "Option::<ScReadableRead>::None";
    if ((flags & 1) !== 0) {
      const readCallback = expr.args[callbackIndex];
      if (readCallback?.type.kind !== "func") {
        this.context.unsupported("Readable read callback shape", expr.loc);
      }
      const shape = this.context.streams.readableReadShapes.get(typeKey(readCallback.type));
      if (shape === undefined) this.context.unsupported("unregistered Readable read callback", expr.loc);
      read = `Some(ScReadableRead::${this.listenerVariant(shape)}(${values[callbackIndex]}))`;
      callbackIndex += 1;
    }
    if ((flags & 2) !== 0) {
      const destroyCallback = expr.args[callbackIndex];
      if (destroyCallback?.type.kind !== "func") {
        this.context.unsupported("Readable destroy callback shape", expr.loc);
      }
      const shape = this.context.streams.readableDestroyShapes.get(typeKey(destroyCallback.type));
      if (shape === undefined) this.context.unsupported("unregistered Readable destroy callback", expr.loc);
      destroy = `Some(ScReadableRead::${this.listenerVariant(shape)}(${values[callbackIndex]}))`;
      callbackIndex += 1;
    }
    if (callbackIndex !== expr.args.length) this.context.unsupported("Readable constructor arity", expr.loc);
    return `{ ${this.bind(expr.args, values)} let _ = ${values[3]}; runtime::readable_new::<ScEmitterListener, ScReadableRead>(${values[0]}, ${values[1]}, ${values[2]}, ${read}, ${destroy}) }`;
  }

  private emitInit(expr: RustLibCallExpr): string {
    const [receiver, highWaterMark, autoDestroy, emitClose, flagsExpr] = expr.args;
    if (receiver === undefined || receiver.type.kind !== "object" || !this.isReadable(receiver) ||
      receiver.type.className === "%Readable" ||
      highWaterMark?.type.kind !== "f64" || autoDestroy?.type.kind !== "bool" ||
      emitClose?.type.kind !== "bool" || flagsExpr?.kind !== "numLit" ||
      expr.type.kind !== "void" || (flagsExpr.value & ~1) !== 0) {
      this.context.unsupported("Readable subclass constructor shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    let callbackIndex = 5;
    let read = "Option::<ScReadableRead>::None";
    if ((flagsExpr.value & 1) !== 0) {
      const callback = expr.args[callbackIndex];
      const first = callback?.type.kind === "func" ? callback.type.params[0] : undefined;
      const second = callback?.type.kind === "func" ? callback.type.params[1] : undefined;
      if (callback?.type.kind !== "func" || callback.type.ret.kind !== "void" ||
        first?.kind !== "object" || first.className !== receiver.type.className ||
        (callback.type.params.length !== 1 &&
          (callback.type.params.length !== 2 || second?.kind !== "f64"))) {
        this.context.unsupported("Readable subclass read callback shape", expr.loc);
      }
      const callbackValue = values[callbackIndex];
      if (callbackValue === undefined) this.context.unsupported("Readable subclass read callback arity", expr.loc);
      const args = [`sc_owner.clone()`, ...(callback.type.params.length === 2 ? ["sc_size"] : [])];
      const dispatch = this.context.emitClosureDispatch("sc_callback", callback.type, args, expr.loc);
      read = `Some({ let sc_context = std::rc::Rc::new((${values[0]}.clone(), ${callbackValue}.clone())); ScReadableRead::RuntimeRead(std::rc::Rc::new({ let sc_context = sc_context.clone(); move |sc_size| { let sc_owner = sc_context.0.clone(); let sc_callback = sc_context.1.clone(); let _ = ${dispatch}; } }), std::rc::Rc::new(move |tracer| { tracer.edge(&sc_context.0); tracer.edge(&sc_context.1); })) })`;
      callbackIndex += 1;
    }
    if (callbackIndex !== expr.args.length) {
      this.context.unsupported("Readable subclass constructor arity", expr.loc);
    }
    return `{ ${this.bind(expr.args, values)} let sc_readable = runtime::readable_new::<ScEmitterListener, ScReadableRead>(${values[1]}, ${values[2]}, ${values[3]}, ${read}, Option::<ScReadableRead>::None); ${values[0]}.with_mut(|object| object.sc_readable = Some(sc_readable)); }`;
  }

  private emitFromArray(expr: RustLibCallExpr): string {
    const [source, strings] = expr.args;
    if (source?.type.kind !== "array" || strings?.kind !== "boolLit" ||
      expr.args.length !== 2 || expr.type.kind !== "object" ||
      expr.type.className !== "%Readable") {
      this.context.unsupported("Readable.from array shape", expr.loc);
    }
    const stringElements = source.type.elem.kind === "string";
    const byteElements = source.type.elem.kind === "bytes" && source.type.elem.elem === "u8";
    if ((!stringElements && !byteElements) || strings.value !== stringElements) {
      this.context.unsupported("Readable.from array element shape", expr.loc);
    }
    const sourceValue = this.context.nextTemporary();
    const readableValue = this.context.nextTemporary();
    const push = stringElements
      ? `runtime::readable_push_object_string(&${readableValue}, runtime::array_get(&${sourceValue}, sc_index))`
      : `let _ = runtime::readable_push(&${readableValue}, runtime::array_get(&${sourceValue}, sc_index))`;
    return `{ let ${sourceValue} = ${this.context.emitExpr(source)}; let ${readableValue} = runtime::readable_new::<ScEmitterListener, ScReadableRead>(1.0, true, true, Option::<ScReadableRead>::None, Option::<ScReadableRead>::None); runtime::readable_set_object_mode(&${readableValue}); let mut sc_index = 0.0; while sc_index < runtime::array_len(&${sourceValue}) { ${push}; sc_index += 1.0; } let _ = runtime::readable_push_null(&${readableValue}); ${readableValue} }`;
  }

  private emitNextChunkDynamic(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (!this.isReadable(receiver) || expr.args.length !== 1 ||
      expr.type.kind !== "promise" || expr.type.inner.kind !== "dyn") {
      this.context.unsupported("Readable async iterator shape", expr.loc);
    }
    const dyn = this.context.dynTypeName();
    const readableValue = this.context.nextTemporary();
    const result = this.context.nextTemporary();
    const target = this.context.nextTemporary();
    const traced = this.context.nextTemporary();
    const outcome = this.context.nextTemporary();
    return `{ let ${readableValue} = ${this.context.emitExpr(receiver)}; let ${result}: runtime::JsPromise<${dyn}> = runtime::promise_new(); let ${target} = ${result}.clone(); let ${traced} = ${result}.clone(); let sc_registered = runtime::readable_set_next_waiter(&${readableValue}, std::rc::Rc::new(move |${outcome}| match ${outcome} { Ok(Some(runtime::ReadableChunk::Bytes(value))) => { let _ = runtime::promise_fulfill(&${target}, ${dyn}::Buffer(value)); }, Ok(Some(runtime::ReadableChunk::String(value))) => { let _ = runtime::promise_fulfill(&${target}, ${dyn}::String(value)); }, Ok(None) => { let _ = runtime::promise_fulfill(&${target}, ${dyn}::Undefined); }, Err(reason) => { let _ = runtime::promise_reject(&${target}, reason); }, }), std::rc::Rc::new(move |tracer| tracer.edge(&${traced}))); if sc_registered { let sc_read_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sc_readable_call_read(&${readableValue}))); if let Err(sc_payload) = sc_read_result { runtime::readable_reject_next(&${readableValue}, runtime::caught_from_panic(sc_payload)); } } else { let sc_reason = runtime::caught_value(runtime::error_new("Error", runtime::string("Readable already has a pending async iterator read"))); let _ = runtime::promise_reject(&${result}, sc_reason); } ${result} }`;
  }

  private emitSetRead(expr: RustLibCallExpr): string {
    const [receiver, callback] = expr.args;
    if (!this.isReadable(receiver) || callback?.type.kind !== "func" ||
      expr.args.length !== 2 || expr.type.kind !== "void") {
      this.context.unsupported("Readable assigned read callback shape", expr.loc);
    }
    const shape = this.context.streams.readableReadShapes.get(typeKey(callback.type));
    if (shape === undefined) this.context.unsupported("unregistered assigned Readable read callback", expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} runtime::readable_set_read_callback(&${values[0]}, ScReadableRead::${this.listenerVariant(shape)}(${values[1]})); }`;
  }

  private emitPush(expr: RustLibCallExpr, stringChunk: boolean): string {
    const [receiver, chunk] = expr.args;
    const expected = stringChunk ? "string" : "bytes";
    if (!this.isReadable(receiver) ||
      chunk?.type.kind !== expected || expr.args.length !== 2 || expr.type.kind !== "bool") {
      this.context.unsupported(`Readable ${stringChunk ? "string " : ""}push shape`, expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const readable = this.readableHandle(this.requiredValue(values, 0, expr.loc), receiver.type, expr.loc);
    const pushed = stringChunk
      ? `runtime::readable_push_string(&sc_readable, &${values[1]})`
      : `runtime::readable_push(&sc_readable, ${values[1]})`;
    return `{ ${this.bind(expr.args, values)} let sc_readable = ${readable}; let sc_result = ${pushed}; sc_readable_schedule(&sc_readable); sc_readable_schedule_notification(&sc_readable); sc_result }`;
  }

  private emitPushStringEncoding(expr: RustLibCallExpr): string {
    const [receiver, chunk, encoding] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      chunk?.type.kind !== "string" || encoding?.type.kind !== "string" ||
      expr.args.length !== 3 || expr.type.kind !== "bool") {
      this.context.unsupported("Readable encoded string push shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} let sc_result = runtime::readable_push_string_encoding(&${values[0]}, &${values[1]}, &${values[2]}); sc_readable_schedule(&${values[0]}); sc_readable_schedule_notification(&${values[0]}); sc_result }`;
  }

  private emitPushEncoding(expr: RustLibCallExpr): string {
    const [receiver, encoding] = expr.args;
    if (!this.isReadable(receiver) ||
      encoding?.type.kind !== "string" || expr.args.length !== 2 ||
      typeKey(expr.type) !== typeKey(receiver.type)) {
      this.context.unsupported("Readable default push encoding shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} runtime::readable_set_push_encoding(&${values[0]}, &${values[1]}); ${values[0]} }`;
  }

  private emitSetEncoding(expr: RustLibCallExpr): string {
    const [receiver, encoding] = expr.args;
    if (!this.isReadable(receiver) || encoding?.type.kind !== "string" ||
      expr.args.length !== 2 || typeKey(expr.type) !== typeKey(receiver.type)) {
      this.context.unsupported("Readable setEncoding shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const readable = this.readableHandle(this.requiredValue(values, 0, expr.loc), receiver.type, expr.loc);
    return `{ ${this.bind(expr.args, values)} let sc_readable = (${readable}).clone(); runtime::readable_set_encoding(&sc_readable, &${values[1]}); ${values[0]} }`;
  }

  private emitPushNull(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (!this.isReadable(receiver) || expr.args.length !== 1 || expr.type.kind !== "bool") {
      this.context.unsupported("Readable null push shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    const readable = this.readableHandle(value, receiver.type, expr.loc);
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; let sc_readable = ${readable}; let sc_result = runtime::readable_push_null(&sc_readable); sc_readable_schedule(&sc_readable); sc_readable_schedule_notification(&sc_readable); sc_result }`;
  }

  private emitPushUnion(expr: RustLibCallExpr): string {
    const [receiver, chunk] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      chunk?.type.kind !== "union" || expr.args.length !== 2 || expr.type.kind !== "bool") {
      this.context.unsupported("Readable union push shape", expr.loc);
    }
    const union = this.context.union(chunk.type.unionId, expr.loc);
    const name = this.context.unionName(union.id);
    const arms = union.arms.map((arm, tag) => {
      const variant = `${name}::${this.context.unionVariant(tag)}`;
      if (arm.kind === "bytes" && arm.elem === "u8") {
        return `${variant}(value) => runtime::readable_push(&sc_readable, value)`;
      }
      if (arm.kind === "string") {
        return `${variant}(value) => runtime::readable_push_string(&sc_readable, &value)`;
      }
      if (arm.kind === "nullT") return `${variant} => runtime::readable_push_null(&sc_readable)`;
      this.context.unsupported(`Readable union push arm '${arm.kind}'`, expr.loc);
    });
    return `{ let sc_readable = ${this.context.emitExpr(receiver)}; let sc_chunk = ${this.context.emitExpr(chunk)}; let sc_result = match sc_chunk { ${arms.join(", ")} }; sc_readable_schedule(&sc_readable); sc_readable_schedule_notification(&sc_readable); sc_result }`;
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
    if (!this.isReadable(receiver) ||
      name?.type.kind !== "string" || expr.args.length !== 2 ||
      (expr.type.kind !== "f64" && expr.type.kind !== "bool")) {
      this.context.unsupported("Readable property shape", expr.loc);
    }
    const helper = expr.type.kind === "f64" ? "readable_prop" : "readable_bool_prop";
    const values = expr.args.map(() => this.context.nextTemporary());
    const readable = this.readableHandle(this.requiredValue(values, 0, expr.loc), receiver.type, expr.loc);
    return `{ ${this.bind(expr.args, values)} let sc_readable = ${readable}; runtime::${helper}(&sc_readable, &${values[1]}) }`;
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

  private emitDestroy(expr: RustLibCallExpr, hasError: boolean): string {
    const [receiver, error] = expr.args;
    if (!this.isReadable(receiver) || expr.type.kind !== "object" || expr.type.className !== "%Readable" ||
      expr.args.length !== (hasError ? 2 : 1) || (hasError &&
        (error?.type.kind !== "object" || error.type.className !== "%Error"))) {
      this.context.unsupported(`Readable destroy${hasError ? "(error)" : ""} shape`, expr.loc);
    }
    this.standardErrorType(expr.loc);
    const readableValue = this.context.nextTemporary();
    const errorValue = hasError ? this.context.nextTemporary() : null;
    const errorOption = errorValue === null ? "Option::<runtime::JsError>::None" : `Some(${errorValue}.clone())`;
    const bindings = [`let ${readableValue} = ${this.context.emitExpr(receiver)};`];
    if (errorValue !== null && error !== undefined) bindings.push(`let ${errorValue} = ${this.context.emitExpr(error)};`);
    const destroyArms = [...this.context.streams.readableDestroyShapes.values()].map((shape) => {
      const [thisType, inputType, completion] = shape.type.params;
      if (shape.type.rest === true || shape.type.params.length !== 3 || shape.type.ret.kind !== "void" ||
        thisType?.kind !== "object" || thisType.className !== "%Readable" || inputType?.kind !== "union" ||
        completion?.kind !== "func" || completion.rest === true || completion.params.length !== 1 ||
        completion.ret.kind !== "void") {
        this.context.unsupported("Readable destroy callback shape", expr.loc);
      }
      const completionArgument = completion.params[0];
      if (completionArgument === undefined) this.context.unsupported("Readable destroy completion argument", expr.loc);
      const completionShape = this.context.closureShapeForType(completion, expr.loc);
      const input = this.errorUnionValue(inputType, errorValue, expr.loc);
      const completedError = this.errorOption("sc_result", completionArgument, expr.loc);
      const completionValue = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_readable = sc_readable_shared.clone(); let sc_called = std::rc::Rc::new(std::cell::Cell::new(false)); move |sc_result| { if sc_called.replace(true) { return; } sc_readable_finish_destroy(sc_readable.as_ref(), ${completedError}); } })), trace: Some(std::rc::Rc::new({ let sc_readable = sc_readable_shared.clone(); move |tracer| tracer.edge(sc_readable.as_ref()) })) })`;
      const dispatch = this.context.emitClosureDispatch("callback", shape.type, [
        `${readableValue}.clone()`, input, completionValue,
      ], expr.loc);
      return `ScReadableRead::${this.listenerVariant(shape)}(callback) => { let sc_readable_shared = std::rc::Rc::new(${readableValue}.clone()); let _ = ${dispatch}; }`;
    });
    destroyArms.push(`ScReadableRead::Never => sc_readable_finish_destroy(&${readableValue}, sc_error)`);
    destroyArms.push("_ => unreachable!(\"scriptc invariant: Readable destroy callback signature\")");
    return `{ ${bindings.join(" ")} let sc_error = ${errorOption}; if runtime::readable_destroy(&${readableValue}, sc_error.clone()) { match runtime::readable_destroy_callback(&${readableValue}) { Some(callback) => match callback { ${destroyArms.join(", ")} }, None => sc_readable_finish_destroy(&${readableValue}, sc_error), } } ${readableValue} }`;
  }

  private emitErrored(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    if (!this.isReadable(receiver) || expr.args.length !== 1 || expr.type.kind !== "union") {
      this.context.unsupported("Readable errored property shape", expr.loc);
    }
    const error = this.errorUnionValue(expr.type, "sc_error", expr.loc);
    const clean = this.errorUnionValue(expr.type, null, expr.loc);
    return `match runtime::readable_error(&(${this.context.emitExpr(receiver)})) { Some(sc_error) => ${error}, None => ${clean}, }`;
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

  private requiredValue(values: readonly string[], index: number, loc: SrcLoc): string {
    const value = values[index];
    if (value === undefined) this.context.unsupported("Readable argument arity", loc);
    return value;
  }

  private listenerVariant(shape: RustClosureShape): string {
    return `Closure${shape.index}`;
  }

  private callbackShapes(): RustClosureShape[] {
    const shapes = new Map<number, RustClosureShape>();
    for (const shape of this.context.streams.readableReadShapes.values()) shapes.set(shape.index, shape);
    for (const shape of this.context.streams.readableDestroyShapes.values()) shapes.set(shape.index, shape);
    return [...shapes.values()];
  }

  private errorUnionValue(type: IrType, error: string | null, loc: SrcLoc): string {
    if (type.kind !== "union") this.context.unsupported("stream error union", loc);
    const union = this.context.union(type.unionId, loc);
    const errorTag = union.arms.findIndex((arm) => arm.kind === "object" && arm.className === "%Error");
    const nullTag = union.arms.findIndex((arm) => arm.kind === "nullT");
    if (errorTag < 0 || nullTag < 0) this.context.unsupported("stream error union arms", loc);
    const name = this.context.unionName(union.id);
    return error === null
      ? `${name}::${this.context.unionVariant(nullTag)}`
      : `${name}::${this.context.unionVariant(errorTag)}(${error})`;
  }

  private errorOption(value: string, type: IrType, loc: SrcLoc): string {
    if (type.kind !== "union") this.context.unsupported("stream completion error union", loc);
    const union = this.context.union(type.unionId, loc);
    const name = this.context.unionName(union.id);
    const arms = union.arms.map((arm, tag) => {
      const variant = `${name}::${this.context.unionVariant(tag)}`;
      if (arm.kind === "object" && arm.className === "%Error") return `${variant}(sc_error) => Some(sc_error)`;
      if (arm.kind === "nullT" || arm.kind === "undefinedT") return `${variant} => None`;
      this.context.unsupported(`stream completion error arm '${arm.kind}'`, loc);
    });
    return `match ${value} { ${arms.join(", ")} }`;
  }

  private standardErrorType(loc: SrcLoc): string {
    const errorType = this.context.rustType({ kind: "object", className: "%Error" }, loc);
    if (errorType !== "runtime::JsError") {
      this.context.unsupported("stream destruction with a custom Error hierarchy", loc);
    }
    return errorType;
  }

  private isReadable(expr: IrExpr | undefined): expr is IrExpr {
    return expr?.type.kind === "object" &&
      (expr.type.className === "%Readable" || this.context.runtimeStreamBase(expr.type.className) === "%Readable");
  }

  private readableHandle(value: string, type: IrType, loc: SrcLoc): string {
    if (type.kind !== "object") this.context.unsupported("Readable receiver type", loc);
    if (type.className === "%Readable") return value;
    if (this.context.runtimeStreamBase(type.className) === "%Readable") {
      return `${value}.with(|object| object.sc_readable.as_ref().expect("scriptc: uninitialized Readable subclass").clone())`;
    }
    this.context.unsupported(`non-Readable receiver '${type.className}'`, loc);
  }
}
