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
  closureName(shape: RustClosureShape): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  sourceLoc(): SrcLoc;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  rustType(type: IrType, loc?: SrcLoc): string;
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
    const voidArms: string[] = [];
    const errorArms: string[] = [];
    const readArms: string[] = [];
    for (const shape of this.context.listenerShapes.values()) {
      if (shape.type.rest === true) continue;
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind === "bytes") {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_chunk.clone()"], loc);
        byteArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
      if (shape.type.params.length === 0) {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, [], loc);
        byteArms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
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
      if (shape.type.rest === true || shape.type.params.length !== 1 ||
        shape.type.params[0]?.kind !== "object" || shape.type.params[0].className !== "%Readable") continue;
      const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_readable.clone()"], loc);
      readArms.push(`ScReadableRead::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
    }
    if (this.context.streams.usesStreamFinished) {
      voidArms.push("ScEmitterListener::RuntimeVoid(callback, _) => callback(),");
      errorArms.push("ScEmitterListener::RuntimeError(callback, _) => callback(sc_error.clone()),");
    }
    byteArms.push("_ => unreachable!(\"scriptc invariant: Readable data listener signature\"),");
    voidArms.push("_ => unreachable!(\"scriptc invariant: Readable lifecycle listener signature\"),");
    errorArms.push("_ => unreachable!(\"scriptc invariant: Readable error listener signature\"),");
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
    this.context.line("runtime::readable_write_pipes(sc_readable, sc_chunk);");
    this.context.popIndent();
    this.context.line("}");
    if (this.context.streams.usesReadableDestroy) {
      this.context.line(`fn sc_readable_emit_error(sc_readable: &ScReadable, sc_error: ${this.standardErrorType(loc)}) {`);
      this.context.pushIndent();
      this.context.line("let sc_emitter = runtime::readable_emitter(sc_readable);");
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
    this.context.line("fn sc_readable_drain(sc_readable: ScReadable) {");
    this.context.pushIndent();
    this.context.line("runtime::readable_begin_drain(&sc_readable);");
    this.context.line("if runtime::readable_take_resume(&sc_readable, false) { sc_readable_emit_void(&sc_readable, \"resume\"); }");
    this.context.line("if let Some(sc_chunk) = runtime::readable_pop(&sc_readable) { sc_readable_emit_data(&sc_readable, sc_chunk); if runtime::readable_take_resume(&sc_readable, true) { sc_readable_emit_void(&sc_readable, \"resume\"); } runtime::readable_end_drain(&sc_readable); if runtime::readable_is_flowing(&sc_readable) { sc_readable_schedule(&sc_readable); } return; }");
    this.context.line("if runtime::readable_take_push_after_eof(&sc_readable) { runtime::throw_error_code(\"stream.push() after EOF\".to_owned(), \"ERR_STREAM_PUSH_AFTER_EOF\"); }");
    this.context.line("if runtime::readable_take_end(&sc_readable) { sc_readable_emit_void(&sc_readable, \"end\"); runtime::readable_end_pipes(&sc_readable); sc_readable_emit_void(&sc_readable, \"close\"); runtime::readable_end_drain(&sc_readable); return; }");
    this.context.line("sc_readable_call_read(&sc_readable);");
    this.context.line("if runtime::readable_has_data_or_eof(&sc_readable) { runtime::readable_end_drain(&sc_readable); sc_readable_schedule(&sc_readable); return; }");
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
      case "readable.pushU": return this.emitPushUnion(expr);
      case "readable.pushNull": return this.emitPushNull(expr);
      case "readable.read": return this.emitRead(expr);
      case "readable.unshift": return this.emitUnshift(expr);
      case "readable.pause": return this.emitPause(expr);
      case "readable.resume": return this.emitResume(expr);
      case "readable.isPaused": return this.emitIsPaused(expr);
      case "readable.flowing": return this.emitFlowing(expr);
      case "stream.prop": return expr.args[0]?.type.kind === "object" &&
        expr.args[0].type.className === "%Readable" ? this.emitProp(expr) : null;
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
    return `{ ${this.bind(expr.args, values)} let _ = (${values[1]}, ${values[3]}); runtime::readable_new::<ScEmitterListener, ScReadableRead>(${values[0]}, ${values[2]}, ${read}, ${destroy}) }`;
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
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      name?.type.kind !== "string" || expr.args.length !== 2 ||
      (expr.type.kind !== "f64" && expr.type.kind !== "bool")) {
      this.context.unsupported("Readable property shape", expr.loc);
    }
    const helper = expr.type.kind === "f64" ? "readable_prop" : "readable_bool_prop";
    return `runtime::${helper}(&(${this.context.emitExpr(receiver)}), &(${this.context.emitExpr(name)}))`;
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
    return expr?.type.kind === "object" && expr.type.className === "%Readable";
  }
}
