import type { IrExpr, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import type { IrFuncType, RustClosureShape } from "./model.js";
import type { RustStreamModel } from "./stream-model.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustWritableContext {
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
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit the module-specialized Writable object and its completion bridges. */
export class RustWritableEmitter {
  constructor(private readonly context: RustWritableContext) {}

  emitTypeDefinition(): void {
    if (!this.context.streams.usesWritable) return;
    this.emitCallbackType("ScWritableWrite", this.context.streams.writableWriteShapes);
    this.emitCallbackType("ScWritableFinal", this.context.streams.writableFinalShapes);
    this.emitCallbackType("ScWritableDone", this.context.streams.writableDoneShapes);
    this.context.line("type ScWritable = runtime::JsWritable<ScEmitterListener, ScWritableWrite, ScWritableFinal, ScWritableDone>;");
  }

  emitDefinitions(): void {
    if (!this.context.streams.usesWritable) return;
    const loc = this.context.sourceLoc();
    const voidArms: string[] = [];
    const errorArms: string[] = [];
    for (const shape of this.context.listenerShapes.values()) {
      if (shape.type.rest !== true && shape.type.params.length === 0) {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, [], loc);
        voidArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
        errorArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
      if (shape.type.rest !== true && shape.type.params.length === 1 &&
        shape.type.params[0]?.kind === "object" && shape.type.params[0].className === "%Error") {
        const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_error.clone()"], loc);
        errorArms.push(`ScEmitterListener::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
      }
    }
    if (this.context.streams.usesStreamFinished) {
      voidArms.push("ScEmitterListener::RuntimeVoid(callback, _) => callback(),");
      errorArms.push("ScEmitterListener::RuntimeError(callback, _) => callback(sc_error.clone()),");
    }
    voidArms.push("_ => unreachable!(\"scriptc invariant: Writable lifecycle listener signature\"),");
    errorArms.push("_ => unreachable!(\"scriptc invariant: Writable error listener signature\"),");
    this.context.line("fn sc_writable_emit_void(sc_writable: &ScWritable, sc_event: &str) {");
    this.context.pushIndent();
    this.context.line("let sc_emitter = runtime::writable_emitter(sc_writable);");
    this.context.line("let sc_name = runtime::string(sc_event);");
    this.context.line("let sc_snapshot = runtime::emitter_snapshot(&sc_emitter, &sc_name);");
    this.context.line("for sc_registration in sc_snapshot { if !runtime::emitter_listener_should_invoke(&sc_registration) { continue; } if sc_registration.once { let _ = runtime::emitter_remove_registration(&sc_emitter, &sc_name, sc_registration.registration); } match sc_registration.callback {");
    this.context.pushIndent();
    for (const arm of voidArms) this.context.line(arm);
    this.context.popIndent();
    this.context.line("} }");
    this.context.popIndent();
    this.context.line("}");
    if (this.context.streams.usesWritableDestroy) {
      this.context.line(`fn sc_writable_emit_error(sc_writable: &ScWritable, sc_error: ${this.standardErrorType(loc)}) {`);
      this.context.pushIndent();
      this.context.line("let sc_emitter = runtime::writable_emitter(sc_writable);");
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
      this.context.line("fn sc_writable_finish_destroy(sc_writable: &ScWritable, sc_error: Option<runtime::JsError>) { if let Some(sc_error) = sc_error { let sc_writable = sc_writable.clone(); runtime::process_next_tick(Box::new(move || sc_writable_emit_error(&sc_writable, sc_error))); } let sc_writable = sc_writable.clone(); runtime::process_next_tick(Box::new(move || { if runtime::writable_take_destroy_close(&sc_writable) { sc_writable_emit_void(&sc_writable, \"close\"); } })); }");
    }
    this.emitWriteDispatch(loc);
    this.emitDoneDispatch(loc);
    this.emitFinalDispatch(loc);
    this.context.line("");
  }

  emitLibCall(expr: RustLibCallExpr): string | null {
    switch (expr.fn) {
      case "writable.new": return this.emitNew(expr);
      case "writable.write": return this.emitWrite(expr, false);
      case "writable.writeStr": return this.emitWrite(expr, true);
      case "writable.end": return this.emitEnd(expr);
      case "writable.cork": return this.emitCork(expr);
      case "writable.uncork": return this.emitUncork(expr);
      case "stream.setWrite": return this.isWritable(expr.args[0]?.type) ? this.emitSetCallback(expr, true) : null;
      case "stream.setFinal": return this.isWritable(expr.args[0]?.type) ? this.emitSetCallback(expr, false) : null;
      case "stream.prop": return this.isWritable(expr.args[0]?.type) ? this.emitProp(expr) : null;
      case "stream.destroy": return this.isWritable(expr.args[0]?.type) ? this.emitDestroy(expr, false) : null;
      case "stream.destroyErr": return this.isWritable(expr.args[0]?.type) ? this.emitDestroy(expr, true) : null;
      case "stream.errored": return this.isWritable(expr.args[0]?.type) ? this.emitErrored(expr) : null;
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

  private emitWriteDispatch(loc: SrcLoc): void {
    const arms: string[] = [];
    for (const shape of this.context.streams.writableWriteShapes.values()) {
      if (shape.type.params.at(-1)?.kind === "dyn") {
        arms.push(this.emitDynamicWriteArm(shape, loc));
        continue;
      }
      const completionType = this.completionType(shape.type, "%Writable write", loc);
      const completionShape = this.context.closureShapeForType(completionType, loc);
      const completionParams = completionType.params.map((_, index) => `sc_arg_${index}`);
      const ignoreParams = completionParams.length === 0 ? "" : `let _ = (${completionParams.join(", ")});`;
      const completion = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_writable = sc_writable.clone(); let sc_done = sc_done.clone(); let sc_called = std::rc::Rc::new(std::cell::Cell::new(false)); move |${completionParams.join(", ")}| { ${ignoreParams} if sc_called.replace(true) { return; } runtime::writable_complete_write(&sc_writable, sc_length); sc_writable_after_write(&sc_writable, sc_done.clone()); } })), trace: Some(std::rc::Rc::new({ let sc_writable = sc_writable.clone(); let sc_done = sc_done.clone(); move |tracer| { tracer.edge(&sc_writable); runtime::Trace::trace(&sc_done, tracer); } })) })`;
      const dispatch = this.context.emitClosureDispatch("callback", shape.type, [
        "sc_writable.clone()", "sc_chunk.clone()", "runtime::string(\"buffer\")", completion,
      ], loc);
      arms.push(`ScWritableWrite::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
    }
    arms.push("ScWritableWrite::Never => { runtime::writable_complete_write(sc_writable, sc_length); sc_writable_after_write(sc_writable, sc_done); },");
    arms.push("_ => unreachable!(\"scriptc invariant: Writable write callback signature\"),");
    this.context.line("fn sc_writable_call_write(sc_writable: &ScWritable, sc_chunk: runtime::JsBytes<u8>, sc_length: usize, sc_done: ScWritableDone) {");
    this.context.pushIndent();
    this.context.line("let Some(sc_callback) = runtime::writable_write_callback(sc_writable) else { runtime::writable_complete_write(sc_writable, sc_length); sc_writable_after_write(sc_writable, sc_done); return; };");
    this.context.line(`match sc_callback { ${arms.join(" ")} }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_writable_end_from_pipe(sc_writable: &ScWritable) { runtime::writable_mark_ended(sc_writable); let sc_finish: std::rc::Rc<dyn Fn()> = std::rc::Rc::new({ let sc_writable = sc_writable.clone(); move || { if runtime::writable_take_prefinish(&sc_writable) { sc_writable_emit_void(&sc_writable, \"prefinish\"); } if runtime::writable_schedule_finish(&sc_writable) { let sc_writable = sc_writable.clone(); runtime::process_next_tick(Box::new(move || { runtime::writable_mark_finished(&sc_writable); sc_writable_emit_void(&sc_writable, \"finish\"); if runtime::writable_take_close(&sc_writable) { sc_writable_emit_void(&sc_writable, \"close\"); } })); } } }); let sc_finish_trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)> = std::rc::Rc::new({ let sc_writable = sc_writable.clone(); move |tracer| tracer.edge(&sc_writable) }); sc_writable_call_final(sc_writable, sc_finish, sc_finish_trace); }");
  }

  private emitDoneDispatch(loc: SrcLoc): void {
    const arms: string[] = [];
    for (const shape of this.context.streams.writableDoneShapes.values()) {
      if (shape.type.rest === true || shape.type.params.length !== 0) continue;
      const dispatch = this.context.emitClosureDispatch("callback", shape.type, [], loc);
      arms.push(`ScWritableDone::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
    }
    arms.push("ScWritableDone::Never => {},");
    arms.push("_ => unreachable!(\"scriptc invariant: Writable completion callback signature\"),");
    this.context.line(`fn sc_writable_call_done(sc_done: ScWritableDone) { match sc_done { ${arms.join(" ")} } }`);
    this.context.line("fn sc_writable_drain_queue(sc_writable: &ScWritable) {");
    this.context.pushIndent();
    this.context.line("if runtime::writable_is_corked(sc_writable) { return; }");
    this.context.line("let Some((sc_chunk, sc_length, sc_done)) = runtime::writable_take_write(sc_writable) else { return; };");
    this.context.line("sc_writable_call_write(sc_writable, sc_chunk, sc_length, sc_done);");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_writable_after_write(sc_writable: &ScWritable, sc_done: ScWritableDone) {");
    this.context.pushIndent();
    this.context.line("sc_writable_drain_queue(sc_writable);");
    this.context.line("if runtime::writable_take_drain(sc_writable) { sc_writable_emit_void(sc_writable, \"drain\"); runtime::writable_resume_sources(sc_writable); }");
    this.context.line("sc_writable_call_done(sc_done);");
    this.context.popIndent();
    this.context.line("}");
  }

  private emitFinalDispatch(loc: SrcLoc): void {
    const arms: string[] = [];
    for (const shape of this.context.streams.writableFinalShapes.values()) {
      if (shape.type.params.at(-1)?.kind === "dyn") {
        arms.push(this.emitDynamicFinalArm(shape, loc));
        continue;
      }
      const completionType = this.completionType(shape.type, "%Writable final", loc);
      const completionShape = this.context.closureShapeForType(completionType, loc);
      const completionParams = completionType.params.map((_, index) => `sc_arg_${index}`);
      const ignoreParams = completionParams.length === 0 ? "" : `let _ = (${completionParams.join(", ")});`;
      const completion = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_finish = sc_finish.clone(); move |${completionParams.join(", ")}| { ${ignoreParams} sc_finish(); } })), trace: Some(sc_finish_trace.clone()) })`;
      const dispatch = this.context.emitClosureDispatch("callback", shape.type, ["sc_writable.clone()", completion], loc);
      arms.push(`ScWritableFinal::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`);
    }
    arms.push("ScWritableFinal::Never => sc_finish(),");
    arms.push("_ => unreachable!(\"scriptc invariant: Writable final callback signature\"),");
    this.context.line("fn sc_writable_call_final(sc_writable: &ScWritable, sc_finish: std::rc::Rc<dyn Fn()>, sc_finish_trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>) {");
    this.context.pushIndent();
    this.context.line("let Some(sc_callback) = runtime::writable_final_callback(sc_writable) else { sc_finish(); return; };");
    this.context.line(`match sc_callback { ${arms.join(" ")} }`);
    this.context.popIndent();
    this.context.line("}");
  }

  private emitDynamicWriteArm(shape: RustClosureShape, loc: SrcLoc): string {
    const completionShape = this.dynamicCompletionShape(loc);
    const completion = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_writable = sc_writable.clone(); let sc_done = sc_done.clone(); let sc_called = std::rc::Rc::new(std::cell::Cell::new(false)); move || { if sc_called.replace(true) { return; } runtime::writable_complete_write(&sc_writable, sc_length); sc_writable_after_write(&sc_writable, sc_done.clone()); } })), trace: Some(std::rc::Rc::new({ let sc_writable = sc_writable.clone(); let sc_done = sc_done.clone(); move |tracer| { tracer.edge(&sc_writable); runtime::Trace::trace(&sc_done, tracer); } })) })`;
    const dynamic = this.dynamicCompletion(completionShape, completion);
    const dyn = this.context.dynTypeName();
    const dispatch = this.context.emitClosureDispatch("callback", shape.type, [
      `${dyn}::Buffer(sc_chunk.clone())`, `${dyn}::String(runtime::string("buffer"))`, dynamic,
    ], loc);
    return `ScWritableWrite::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`;
  }

  private emitDynamicFinalArm(shape: RustClosureShape, loc: SrcLoc): string {
    const completionShape = this.dynamicCompletionShape(loc);
    const completion = `runtime::Gc::new(${this.context.closureName(completionShape)}::RuntimeCallback { callback: Some(std::rc::Rc::new({ let sc_finish = sc_finish.clone(); move || sc_finish() })), trace: Some(sc_finish_trace.clone()) })`;
    const dispatch = this.context.emitClosureDispatch(
      "callback", shape.type, [this.dynamicCompletion(completionShape, completion)], loc,
    );
    return `ScWritableFinal::${this.variant(shape)}(callback) => { let _ = ${dispatch}; },`;
  }

  private dynamicCompletion(shape: RustClosureShape, completion: string): string {
    return `${this.context.dynTypeName()}::${this.context.dynFunctionVariant(shape)}(${completion}, runtime::empty_string(), runtime::map_new())`;
  }

  private dynamicCompletionShape(loc: SrcLoc): RustClosureShape {
    const shape = this.context.streams.writableDynamicCompletionShape;
    if (shape === null) this.context.unsupported("unregistered dynamic Writable completion callback", loc);
    return shape;
  }

  private emitNew(expr: RustLibCallExpr): string {
    const [highWaterMark, autoDestroy, emitClose, flagsExpr] = expr.args;
    if (highWaterMark?.type.kind !== "f64" || autoDestroy?.type.kind !== "bool" ||
      emitClose?.type.kind !== "bool" || flagsExpr?.kind !== "numLit" ||
      expr.type.kind !== "object" || expr.type.className !== "%Writable") {
      this.context.unsupported("Writable constructor shape", expr.loc);
    }
    const flags = flagsExpr.value;
    if ((flags & ~3) !== 0) this.context.unsupported("Writable constructor callback set", expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    let callbackIndex = 4;
    let write = "Option::<ScWritableWrite>::None";
    let final = "Option::<ScWritableFinal>::None";
    if ((flags & 1) !== 0) {
      const callback = expr.args[callbackIndex];
      if (callback?.type.kind !== "func") this.context.unsupported("Writable write callback shape", expr.loc);
      const shape = this.context.streams.writableWriteShapes.get(typeKey(callback.type));
      if (shape === undefined) this.context.unsupported("unregistered Writable write callback", expr.loc);
      write = `Some(ScWritableWrite::${this.variant(shape)}(${values[callbackIndex]}))`;
      callbackIndex += 1;
    }
    if ((flags & 2) !== 0) {
      const callback = expr.args[callbackIndex];
      if (callback?.type.kind !== "func") this.context.unsupported("Writable final callback shape", expr.loc);
      const shape = this.context.streams.writableFinalShapes.get(typeKey(callback.type));
      if (shape === undefined) this.context.unsupported("unregistered Writable final callback", expr.loc);
      final = `Some(ScWritableFinal::${this.variant(shape)}(${values[callbackIndex]}))`;
      callbackIndex += 1;
    }
    if (callbackIndex !== expr.args.length) this.context.unsupported("Writable constructor arity", expr.loc);
    return `{ ${this.bind(expr.args, values)} let _ = ${values[3]}; runtime::writable_new::<ScEmitterListener, ScWritableWrite, ScWritableFinal, ScWritableDone>(${values[0]}, ${values[1]}, ${values[2]}, ${write}, ${final}) }`;
  }

  private emitSetCallback(expr: RustLibCallExpr, write: boolean): string {
    const [receiver, callback] = expr.args;
    if (!this.isWritable(receiver?.type) || callback?.type.kind !== "func" ||
      expr.args.length !== 2 || expr.type.kind !== "void") {
      this.context.unsupported(`Writable assigned ${write ? "write" : "final"} callback shape`, expr.loc);
    }
    const shapes = write ? this.context.streams.writableWriteShapes : this.context.streams.writableFinalShapes;
    const shape = shapes.get(typeKey(callback.type));
    if (shape === undefined) {
      this.context.unsupported(`unregistered assigned Writable ${write ? "write" : "final"} callback`, expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const runtime = write ? "writable_set_write_callback" : "writable_set_final_callback";
    const variant = write ? "ScWritableWrite" : "ScWritableFinal";
    return `{ ${this.bind(expr.args, values)} runtime::${runtime}(&${values[0]}, ${variant}::${this.variant(shape)}(${values[1]})); }`;
  }

  private emitWrite(expr: RustLibCallExpr, stringChunk: boolean): string {
    const [receiver, chunk] = expr.args;
    const expected = stringChunk ? "string" : "bytes";
    if (!this.isWritable(receiver?.type) || chunk?.type.kind !== expected || (expr.args.length !== 2 && expr.args.length !== 3) ||
      expr.type.kind !== "bool" || (chunk.type.kind === "bytes" && chunk.type.elem !== "u8")) {
      this.context.unsupported(`Writable ${stringChunk ? "string " : ""}write shape`, expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const converted = stringChunk
      ? `runtime::buffer_from_string(&${values[1]}, &runtime::string("utf8"))`
      : values[1];
    let done = "ScWritableDone::Never";
    const callback = expr.args[2];
    if (callback !== undefined) {
      if (callback.type.kind !== "func" || callback.type.params.length !== 0) {
        this.context.unsupported("Writable write completion callback", expr.loc);
      }
      const shape = this.context.streams.writableDoneShapes.get(typeKey(callback.type));
      if (shape === undefined) this.context.unsupported("unregistered Writable completion callback", expr.loc);
      done = `ScWritableDone::${this.variant(shape)}(${values[2]})`;
    }
    return `{ ${this.bind(expr.args, values)} let sc_chunk = ${converted}; let sc_result = runtime::writable_enqueue(&${values[0]}, sc_chunk, ${done}); sc_writable_drain_queue(&${values[0]}); sc_result }`;
  }

  private emitEnd(expr: RustLibCallExpr): string {
    const [receiver, flagsExpr] = expr.args;
    if (!this.isWritable(receiver?.type) || flagsExpr?.kind !== "numLit" ||
      expr.type.kind !== "object" || expr.type.className !== "%Writable") {
      this.context.unsupported("Writable end shape", expr.loc);
    }
    const flags = flagsExpr.value;
    if ((flags & ~7) !== 0 || (flags & 3) === 3) this.context.unsupported("Writable end flags", expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    let argumentIndex = 2;
    let write = "";
    if ((flags & 3) !== 0) {
      const chunk = expr.args[argumentIndex];
      const stringChunk = (flags & 2) !== 0;
      if (chunk === undefined || chunk.type.kind !== (stringChunk ? "string" : "bytes")) {
        this.context.unsupported("Writable end chunk", expr.loc);
      }
      const converted = stringChunk
        ? `runtime::buffer_from_string(&${values[argumentIndex]}, &runtime::string("utf8"))`
        : values[argumentIndex];
      write = `let sc_chunk = ${converted}; let _ = runtime::writable_enqueue(&${values[0]}, sc_chunk, ScWritableDone::Never); sc_writable_drain_queue(&${values[0]});`;
      argumentIndex += 1;
    }
    let endDispatch = "";
    let endTrace = "";
    let endClone = "";
    let endInnerClone = "";
    if ((flags & 4) !== 0) {
      const callback = expr.args[argumentIndex];
      if (callback?.type.kind !== "func" || callback.type.params.length !== 0) {
        this.context.unsupported("Writable end callback", expr.loc);
      }
      const callbackValue = values[argumentIndex];
      if (callbackValue === undefined) this.context.unsupported("Writable end callback arity", expr.loc);
      endDispatch = `let _ = ${this.context.emitClosureDispatch("sc_end_callback", callback.type, [], expr.loc)};`;
      endTrace = "tracer.edge(&sc_end_callback);";
      endClone = `let sc_end_callback = ${callbackValue}.clone();`;
      endInnerClone = "let sc_end_callback = sc_end_callback.clone();";
      argumentIndex += 1;
    }
    if (argumentIndex !== expr.args.length) this.context.unsupported("Writable end arity", expr.loc);
    const finish = `let sc_finish: std::rc::Rc<dyn Fn()> = std::rc::Rc::new({ let sc_writable = ${values[0]}.clone(); ${endClone} move || { if runtime::writable_take_prefinish(&sc_writable) { sc_writable_emit_void(&sc_writable, "prefinish"); } if runtime::writable_schedule_finish(&sc_writable) { let sc_writable = sc_writable.clone(); ${endInnerClone} runtime::process_next_tick(Box::new(move || { runtime::writable_mark_finished(&sc_writable); ${endDispatch} sc_writable_emit_void(&sc_writable, "finish"); if runtime::writable_take_close(&sc_writable) { sc_writable_emit_void(&sc_writable, "close"); } })); } } });`;
    const trace = `let sc_finish_trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)> = std::rc::Rc::new({ let sc_writable = ${values[0]}.clone(); ${endClone} move |tracer| { tracer.edge(&sc_writable); ${endTrace} } });`;
    return `{ ${this.bind(expr.args, values)} runtime::writable_mark_ended(&${values[0]}); ${write} ${finish} ${trace} sc_writable_call_final(&${values[0]}, sc_finish, sc_finish_trace); ${values[0]} }`;
  }

  private emitProp(expr: RustLibCallExpr): string {
    const [receiver, name] = expr.args;
    if (receiver === undefined || name === undefined || !this.isWritable(receiver.type) || name.type.kind !== "string" || expr.args.length !== 2 ||
      (expr.type.kind !== "f64" && expr.type.kind !== "bool")) {
      this.context.unsupported("Writable property shape", expr.loc);
    }
    const helper = expr.type.kind === "f64" ? "writable_number_prop" : "writable_bool_prop";
    return `runtime::${helper}(&(${this.context.emitExpr(receiver)}), &(${this.context.emitExpr(name)}))`;
  }

  private emitCork(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    if (receiver === undefined || !this.isWritable(receiver.type) || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("Writable cork shape", expr.loc);
    }
    return `runtime::writable_cork(&(${this.context.emitExpr(receiver)}))`;
  }

  private emitUncork(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    if (receiver === undefined || !this.isWritable(receiver.type) || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("Writable uncork shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; if runtime::writable_uncork(&${value}) { sc_writable_drain_queue(&${value}); } }`;
  }

  private emitDestroy(expr: RustLibCallExpr, hasError: boolean): string {
    const [receiver, error] = expr.args;
    if (receiver === undefined || !this.isWritable(receiver.type) || expr.type.kind !== "object" || expr.type.className !== "%Writable" ||
      expr.args.length !== (hasError ? 2 : 1) || (hasError &&
        (error?.type.kind !== "object" || error.type.className !== "%Error"))) {
      this.context.unsupported(`Writable destroy${hasError ? "(error)" : ""} shape`, expr.loc);
    }
    this.standardErrorType(expr.loc);
    const writableValue = this.context.nextTemporary();
    const errorValue = hasError ? this.context.nextTemporary() : null;
    const bindings = [`let ${writableValue} = ${this.context.emitExpr(receiver)};`];
    if (errorValue !== null && error !== undefined) bindings.push(`let ${errorValue} = ${this.context.emitExpr(error)};`);
    const errorOption = errorValue === null ? "Option::<runtime::JsError>::None" : `Some(${errorValue})`;
    return `{ ${bindings.join(" ")} let sc_error = ${errorOption}; if runtime::writable_destroy(&${writableValue}, sc_error.clone()) { sc_writable_finish_destroy(&${writableValue}, sc_error); } ${writableValue} }`;
  }

  private emitErrored(expr: RustLibCallExpr): string {
    const receiver = expr.args[0];
    if (receiver === undefined || !this.isWritable(receiver.type) || expr.args.length !== 1 || expr.type.kind !== "union") {
      this.context.unsupported("Writable errored property shape", expr.loc);
    }
    const error = this.errorUnionValue(expr.type, "sc_error", expr.loc);
    const clean = this.errorUnionValue(expr.type, null, expr.loc);
    return `match runtime::writable_error(&(${this.context.emitExpr(receiver)})) { Some(sc_error) => ${error}, None => ${clean}, }`;
  }

  private completionType(type: IrFuncType, what: string, loc: SrcLoc): IrFuncType {
    const completion = type.params.at(-1);
    if (completion?.kind !== "func") this.context.unsupported(`${what} completion shape`, loc);
    return completion;
  }

  private bind(args: readonly IrExpr[], values: readonly string[]): string {
    return args.map((arg, index) => `let ${values[index]} = ${this.context.emitExpr(arg)};`).join(" ");
  }

  private isWritable(type: IrExpr["type"] | undefined): boolean {
    return type?.kind === "object" && type.className === "%Writable";
  }

  private variant(shape: RustClosureShape): string {
    return `Closure${shape.index}`;
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

  private standardErrorType(loc: SrcLoc): string {
    const errorType = this.context.rustType({ kind: "object", className: "%Error" }, loc);
    if (errorType !== "runtime::JsError") {
      this.context.unsupported("stream destruction with a custom Error hierarchy", loc);
    }
    return errorType;
  }
}
