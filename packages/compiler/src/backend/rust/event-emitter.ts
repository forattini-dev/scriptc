import type { IrExpr, IrType, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_EMITTER_CLASS, RUNTIME_STREAM_CLASSES, typeKey } from "../../ir/nodes.js";
import type { IrFuncType, RustClassMeta, RustClosureShape } from "./model.js";
import { RustReadableEmitter, type RustReadableContext } from "./readable.js";
import { RustWritableEmitter, type RustWritableContext } from "./writable.js";
import { RustDuplexEmitter, type RustDuplexContext } from "./duplex.js";
import { RustTransformEmitter, type RustTransformContext } from "./transform.js";
import { RustStreamPromiseEmitter } from "./stream-promises.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustEventEmitterContext extends RustReadableContext, RustWritableContext, RustDuplexContext, RustTransformContext {
  readonly snapshotShapes: ReadonlyMap<string, RustClosureShape>;
  emitterRoots(): RustClassMeta[];
  classMeta(name: string, loc?: SrcLoc): RustClassMeta;
  isEmitterClass(name: string): boolean;
  runtimeStreamBase(name: string): "%Readable" | "%Writable" | "%Duplex" | "%Transform" | null;
  isUsed(): boolean;
  usesProcessExitListeners(): boolean;
  usesProcessRejectionEvents(): boolean;
  usesProcessWarningEvents(): boolean;
  hasErrorClassRoots(): boolean;
  errorValueName(): string;
  dynTypeName(): string;
  classStructName(name: string, loc?: SrcLoc): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  needsClone(type: IrType): boolean;
  rustString(value: string): string;
  rustType(type: IrType, loc?: SrcLoc): string;
}

/** Emit the module-specialized, strongly typed EventEmitter bridge. */
export class RustEventEmitterEmitter {
  private readonly readable: RustReadableEmitter;
  private readonly writable: RustWritableEmitter;
  private readonly duplex: RustDuplexEmitter;
  private readonly transform: RustTransformEmitter;
  private readonly streamPromises: RustStreamPromiseEmitter;

  constructor(private readonly context: RustEventEmitterContext) {
    this.readable = new RustReadableEmitter(context);
    this.writable = new RustWritableEmitter(context);
    this.duplex = new RustDuplexEmitter(context);
    this.transform = new RustTransformEmitter(context);
    this.streamPromises = new RustStreamPromiseEmitter(context);
  }

  emitDefinition(): void {
    if (!this.context.isUsed()) return;
    this.context.line("#[derive(Clone)]");
    this.context.line("enum ScEmitterListener {");
    this.context.pushIndent();
    this.context.line("Never,");
    if (this.context.streams.usesStreamFinished) {
      this.context.line("RuntimeVoid(std::rc::Rc<dyn Fn()>, std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>),");
      this.context.line("RuntimeError(std::rc::Rc<dyn Fn(runtime::JsError)>, std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>),");
    }
    if (this.context.streams.usesStreamConsumers) {
      this.context.line("RuntimeData(std::rc::Rc<dyn Fn(Option<runtime::JsBytes<u8>>, Option<runtime::JsString>)>, std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>),");
    }
    for (const shape of this.context.listenerShapes.values()) {
      this.context.line(`${this.listenerVariant(shape)}(runtime::Gc<${this.context.closureName(shape)}>),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.line("impl runtime::Trace for ScEmitterListener {");
    this.context.pushIndent();
    this.context.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
    this.context.pushIndent();
    this.context.line("match self {");
    this.context.pushIndent();
    this.context.line("Self::Never => {},");
    if (this.context.streams.usesStreamFinished) {
      this.context.line("Self::RuntimeVoid(_, trace) | Self::RuntimeError(_, trace) => trace(tracer),");
    }
    if (this.context.streams.usesStreamConsumers) {
      this.context.line("Self::RuntimeData(_, trace) => trace(tracer),");
    }
    for (const shape of this.context.listenerShapes.values()) {
      this.context.line(`Self::${this.listenerVariant(shape)}(callback) => tracer.edge(callback),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("type ScEmitterRegistry = runtime::JsEventEmitter<ScEmitterListener>;");
    this.readable.emitTypeDefinition();
    this.writable.emitTypeDefinition();
    this.duplex.emitTypeDefinition();
    this.transform.emitTypeDefinition();
    this.emitObjectDefinition();
    this.context.line("");
    this.emitMetaDispatchHelper();
    this.emitSnapshotDispatchHelpers();
    this.emitProcessExitDefinitions();
    this.emitProcessRejectionDefinitions();
    this.emitProcessWarningDefinitions();
    this.readable.emitDefinitions();
    this.writable.emitDefinitions();
    this.duplex.emitDefinitions();
    this.transform.emitDefinitions();
    this.streamPromises.emitDefinitions();
  }

  emitUpcast(value: string, source: IrType, loc: SrcLoc): string | null {
    if (source.kind === "object" && source.className === "%Readable") {
      return `ScEventEmitter::Readable(${value})`;
    }
    if (source.kind === "object" && source.className === "%Writable") {
      return `ScEventEmitter::Writable(${value})`;
    }
    if (source.kind === "object" && source.className === "%Duplex") {
      return `ScEventEmitter::Duplex(${value})`;
    }
    if (source.kind === "object" && (source.className === "%Transform" || source.className === "%PassThrough")) {
      return `ScEventEmitter::Transform(${value})`;
    }
    if (source.kind !== "object" || !this.context.isEmitterClass(source.className)) return null;
    return `ScEventEmitter::${this.objectVariant(this.classMeta(source.className, loc).root)}(${value})`;
  }

  emitDowncast(value: string, source: IrType, target: IrType, loc: SrcLoc): string | null {
    if (source.kind !== "object" || source.className !== RUNTIME_EMITTER_CLASS ||
      target.kind !== "object" || !this.context.isEmitterClass(target.className)) return null;
    const meta = this.classMeta(target.className, loc);
    const variant = this.objectVariant(meta.root);
    return `{ let sc_value = ${value}; match sc_value { ScEventEmitter::${variant}(object) => { if !object.with(|object| ${meta.pre} <= object.sc_class_pre && object.sc_class_pre <= ${meta.post}) { unreachable!("scriptc invariant: invalid EventEmitter subclass downcast"); } object }, _ => unreachable!("scriptc invariant: invalid EventEmitter subclass downcast"), } }`;
  }

  emitInstanceOf(value: string, source: IrType, target: string, loc: SrcLoc): string | null {
    if (source.kind !== "object") return null;
    if (target === RUNTIME_EMITTER_CLASS) {
      return `{ let sc_value = ${value}; let _ = sc_value; ${this.isEmitterObject(source) ? "true" : "false"} }`;
    }
    if (RUNTIME_STREAM_CLASSES.has(target)) {
      const runtimeBase = RUNTIME_STREAM_CLASSES.has(source.className)
        ? source.className
        : this.context.runtimeStreamBase(source.className);
      if (runtimeBase !== null) {
        return `{ let sc_value = ${value}; let _ = sc_value; ${this.runtimeStreamIsA(runtimeBase, target)} }`;
      }
    }
    if (source.className !== RUNTIME_EMITTER_CLASS) return null;
    if (!this.context.isEmitterClass(target)) {
      return `{ let sc_value = ${value}; let _ = sc_value; false }`;
    }
    const targetRoot = this.classMeta(target, loc).root;
    const targetPre = this.classPre(target, loc);
    const targetMeta = this.classMeta(target, loc);
    return `{ let sc_value = ${value}; match &sc_value { ScEventEmitter::${this.objectVariant(targetRoot)}(object) => object.with(|object| ${targetPre} <= object.sc_class_pre && object.sc_class_pre <= ${targetMeta.post}), _ => false, } }`;
  }

  emitLibCall(expr: RustLibCallExpr): string | null {
    switch (expr.fn) {
      case "emitter.new":
        if (expr.args.length !== 0 || !this.isBareEmitter(expr.type)) {
          this.context.unsupported("EventEmitter constructor shape", expr.loc);
        }
        return "ScEventEmitter::Bare(runtime::emitter_new::<ScEmitterListener>())";
      case "emitter.ctor": return this.emitConstructor(expr);
      case "emitter.on": return this.emitOn(expr);
      case "emitter.onData": return this.emitOn(expr, true);
      case "emitter.off": return this.emitOff(expr);
      case "emitter.checkListener": return this.emitCheckListener(expr);
      case "emitter.onDyn": return this.emitOnDynamic(expr);
      case "emitter.onDataDyn": return this.emitOnDynamic(expr, true);
      case "emitter.offDyn": return this.emitOffDynamic(expr);
      case "emitter.removeAll": return this.emitRemoveAll(expr);
      case "emitter.emit": return this.emitEvent(expr);
      case "emitter.emitError": return this.emitEvent(expr, true);
      case "emitter.count": return this.emitCount(expr);
      case "emitter.countFn": return this.emitCountIdentity(expr);
      case "emitter.names": return this.emitNames(expr);
      case "emitter.listeners": return this.emitListeners(expr);
      case "emitter.setMax": return this.emitSetMax(expr);
      case "emitter.setMaxChk": return this.emitSetMaxChecked(expr);
      case "emitter.getMax": return this.emitGetMax(expr);
      case "emitter.setDefaultMax": return this.emitSetDefaultMax(expr);
      case "emitter.setDefaultMaxChk": return this.emitSetDefaultMaxChecked(expr);
      case "emitter.getDefaultMax": return this.emitGetDefaultMax(expr);
      case "process.onExit": return this.emitProcessOnExit(expr);
      case "process.offExit": return this.emitProcessOffExit(expr);
      case "process.exit": return this.context.usesProcessExitListeners()
        ? this.emitProcessExit(expr)
        : null;
      case "process.onUnhandledRejection": return this.emitProcessRejectionOn(expr, true);
      case "process.offUnhandledRejection": return this.emitProcessRejectionOff(expr, true);
      case "process.onRejectionHandled": return this.emitProcessRejectionOn(expr, false);
      case "process.offRejectionHandled": return this.emitProcessRejectionOff(expr, false);
      case "process.onWarning": return this.emitProcessWarningOn(expr);
      case "process.offWarning": return this.emitProcessWarningOff(expr);
      case "process.emitWarning": return this.emitProcessWarning(expr);
      case "readable.pipe": return this.emitPipe(expr);
      case "readable.unpipe": return this.emitUnpipe(expr);
      case "stream.finished":
      case "stream.finishedDyn": return this.streamPromises.emitCallbackFinished(expr);
      case "sp.finished": return this.streamPromises.emitFinished(expr);
      case "sp.pipeline": return this.emitPromisePipeline(expr);
      case "sc.text":
      case "sc.json":
      case "sc.buffer": return this.streamPromises.emitConsumer(expr);
      default: return this.transform.emitLibCall(expr) ?? this.duplex.emitLibCall(expr) ??
        this.readable.emitLibCall(expr) ?? this.writable.emitLibCall(expr);
    }
  }

  private emitPipe(expr: RustLibCallExpr): string {
    const [source, destination, end] = expr.args;
    if (source?.type.kind !== "object" || destination?.type.kind !== "object" ||
      end?.type.kind !== "bool" || expr.args.length !== 3 ||
      expr.type.kind !== "object" || expr.type.className !== destination.type.className) {
      this.context.unsupported("Readable pipe shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const sourceValue = this.requiredValue(values, 0, expr.loc);
    const destinationValue = this.requiredValue(values, 1, expr.loc);
    const endValue = this.requiredValue(values, 2, expr.loc);
    const pipe = this.emitPipeBound(source.type, destination.type, sourceValue, destinationValue, endValue, expr.loc);
    return `{ ${this.bind(expr.args, values)} ${pipe} ${destinationValue} }`;
  }

  private emitPromisePipeline(expr: RustLibCallExpr): string {
    const count = expr.args[0];
    if (count?.kind !== "numLit" || !Number.isInteger(count.value) || count.value < 2 ||
      expr.args.length !== count.value + 1 || expr.type.kind !== "promise" || expr.type.inner.kind !== "void") {
      this.context.unsupported("stream/promises pipeline shape", expr.loc);
    }
    const streams = expr.args.slice(1);
    const values = streams.map(() => this.context.nextTemporary());
    const bindings = streams.map((stream, index) => `let ${values[index]} = ${this.context.emitExpr(stream)};`).join(" ");
    const pipes = streams.slice(0, -1).map((source, index) => {
      const destination = streams[index + 1];
      const sourceValue = values[index];
      const destinationValue = values[index + 1];
      if (destination === undefined || sourceValue === undefined || destinationValue === undefined) {
        this.context.unsupported("stream/promises pipeline stages", expr.loc);
      }
      return this.emitPipeBound(source.type, destination.type, sourceValue, destinationValue, "true", expr.loc);
    }).join(" ");
    const wrapped = streams.map((stream, index) => {
      const value = values[index];
      if (value === undefined) this.context.unsupported("stream/promises pipeline stage", expr.loc);
      return this.streamPromises.streamValue(stream.type, `${value}.clone()`, expr.loc);
    }).join(", ");
    return `{ ${bindings} ${pipes} sc_stream_promise_pipeline(vec![${wrapped}]) }`;
  }

  private emitPipeBound(
    sourceType: IrType,
    destinationType: IrType,
    sourceValue: string,
    destinationValue: string,
    endValue: string,
    loc: SrcLoc,
  ): string {
    if (sourceType.kind !== "object" || destinationType.kind !== "object") {
      this.context.unsupported("Readable pipe object types", loc);
    }
    const readable = this.pipeReadable(sourceValue, sourceType.className, loc);
    const write = this.pipeWrite(destinationValue, destinationType.className, loc);
    const finish = this.pipeEnd(destinationValue, destinationType.className, loc);
    const unpipe = this.pipeEvent("sc_destination", destinationType.className, "unpipe", loc);
    const pipe = this.pipeEvent(destinationValue, destinationType.className, "pipe", loc);
    const start = this.pipeStart(sourceValue, sourceType.className, loc);
    const resume = this.pipeResume(sourceType.className, loc);
    const backpressure = this.pipeBackpressure(destinationType.className, loc);
    return `let sc_readable = ${readable}; let sc_identity = ${destinationValue}.identity(); let sc_destination_shared = std::rc::Rc::new(${destinationValue}.clone()); let sc_source_shared = std::rc::Rc::new(${sourceValue}.clone()); let sc_write: std::rc::Rc<dyn Fn(runtime::JsBytes<u8>) -> bool> = std::rc::Rc::new({ let sc_destination_shared = sc_destination_shared.clone(); move |sc_chunk| { let sc_destination = sc_destination_shared.as_ref(); ${write} } }); let sc_finish: std::rc::Rc<dyn Fn()> = std::rc::Rc::new({ let sc_destination_shared = sc_destination_shared.clone(); move || { let sc_destination = sc_destination_shared.as_ref(); ${finish} } }); let sc_unpipe: std::rc::Rc<dyn Fn()> = std::rc::Rc::new({ let sc_destination_shared = sc_destination_shared.clone(); move || { let sc_destination = sc_destination_shared.as_ref(); ${unpipe} } }); let sc_resume: std::rc::Rc<dyn Fn()> = std::rc::Rc::new({ let sc_source_shared = sc_source_shared.clone(); move || { let sc_source = sc_source_shared.as_ref(); ${resume} } }); let sc_resume_trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)> = std::rc::Rc::new({ let sc_source_shared = sc_source_shared.clone(); move |tracer| tracer.edge(sc_source_shared.as_ref()) }); let sc_backpressure: std::rc::Rc<dyn Fn(std::rc::Rc<dyn Fn()>, std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)>)> = std::rc::Rc::new({ let sc_destination_shared = sc_destination_shared.clone(); move |sc_resume, sc_resume_trace| { let sc_destination = sc_destination_shared.as_ref(); ${backpressure} } }); let sc_trace: std::rc::Rc<dyn Fn(&mut runtime::Tracer<'_>)> = std::rc::Rc::new({ let sc_destination_shared = sc_destination_shared.clone(); move |tracer| tracer.edge(sc_destination_shared.as_ref()) }); runtime::readable_add_pipe(&sc_readable, sc_identity, ${endValue}, sc_write, sc_finish, sc_unpipe, sc_resume, sc_resume_trace, sc_backpressure, sc_trace); ${pipe} ${start}`;
  }

  private emitUnpipe(expr: RustLibCallExpr): string {
    const source = expr.args[0];
    if (source?.type.kind !== "object" || (expr.args.length !== 1 && expr.args.length !== 2) ||
      expr.type.kind !== "object" || expr.type.className !== source.type.className) {
      this.context.unsupported("Readable unpipe shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const sourceValue = this.requiredValue(values, 0, expr.loc);
    const readable = this.pipeReadable(sourceValue, source.type.className, expr.loc);
    const identity = values[1] === undefined ? "None" : `Some(${values[1]}.identity())`;
    return `{ ${this.bind(expr.args, values)} let sc_readable = ${readable}; runtime::readable_unpipe(&sc_readable, ${identity}); ${sourceValue} }`;
  }

  private pipeReadable(value: string, className: string, loc: SrcLoc): string {
    if (className === "%Readable") return `${value}.clone()`;
    if (className === "%Duplex") return `runtime::duplex_readable(&${value})`;
    if (className === "%Transform" || className === "%PassThrough") {
      return `runtime::transform_readable(&${value})`;
    }
    this.context.unsupported(`pipe source '${className}'`, loc);
  }

  private pipeWrite(value: string, className: string, loc: SrcLoc): string {
    void value;
    if (className === "%Writable") {
      return "let sc_result = runtime::writable_enqueue(&sc_destination, sc_chunk, ScWritableDone::Never); sc_writable_drain_queue(&sc_destination); sc_result";
    }
    if (className === "%Transform" || className === "%PassThrough") {
      return "let sc_writable = runtime::transform_writable(&sc_destination); let sc_result = runtime::writable_enqueue(&sc_writable, sc_chunk, ScTransformDone::Never); sc_transform_drain_write(&sc_destination); sc_result";
    }
    if (className === "%Duplex") {
      return "let sc_writable = runtime::duplex_writable(&sc_destination); let sc_result = runtime::writable_enqueue(&sc_writable, sc_chunk, ScDuplexDone::Never); sc_duplex_write_drain(&sc_destination); sc_result";
    }
    this.context.unsupported(`pipe destination '${className}'`, loc);
  }

  private pipeEnd(value: string, className: string, loc: SrcLoc): string {
    void value;
    if (className === "%Writable") return "sc_writable_end_from_pipe(&sc_destination);";
    if (className === "%Transform" || className === "%PassThrough") {
      return "sc_transform_end_from_pipe(&sc_destination);";
    }
    this.context.unsupported(`pipe end destination '${className}'`, loc);
  }

  private pipeEvent(value: string, className: string, event: string, loc: SrcLoc): string {
    const receiver = `&${value}`;
    if (className === "%Writable") return `sc_writable_emit_void(${receiver}, "${event}");`;
    if (className === "%Transform" || className === "%PassThrough") {
      return `sc_transform_emit_void(${receiver}, "${event}");`;
    }
    if (className === "%Duplex") return `sc_duplex_emit_void(${receiver}, "${event}");`;
    this.context.unsupported(`pipe event destination '${className}'`, loc);
  }

  private pipeStart(value: string, className: string, loc: SrcLoc): string {
    if (className === "%Readable") {
      return `runtime::readable_start_flowing(&${value}); sc_readable_schedule(&${value});`;
    }
    if (className === "%Duplex") return `sc_duplex_start_flowing(&${value});`;
    if (className === "%Transform" || className === "%PassThrough") {
      return `sc_transform_start_flowing(&${value});`;
    }
    this.context.unsupported(`pipe flow source '${className}'`, loc);
  }

  private pipeResume(className: string, loc: SrcLoc): string {
    if (className === "%Readable") {
      return "runtime::readable_resume(&sc_source); sc_readable_schedule(&sc_source);";
    }
    if (className === "%Duplex") return "sc_duplex_start_flowing(&sc_source);";
    if (className === "%Transform" || className === "%PassThrough") {
      return "sc_transform_start_flowing(&sc_source);";
    }
    this.context.unsupported(`pipe resume source '${className}'`, loc);
  }

  private pipeBackpressure(className: string, loc: SrcLoc): string {
    if (className === "%Writable") {
      return "runtime::writable_add_drain_resume(&sc_destination, sc_resume, sc_resume_trace);";
    }
    if (className === "%Transform" || className === "%PassThrough") {
      return "runtime::writable_add_drain_resume(&runtime::transform_writable(&sc_destination), sc_resume, sc_resume_trace);";
    }
    if (className === "%Duplex") {
      return "runtime::writable_add_drain_resume(&runtime::duplex_writable(&sc_destination), sc_resume, sc_resume_trace);";
    }
    this.context.unsupported(`pipe backpressure destination '${className}'`, loc);
  }

  private emitOn(expr: RustLibCallExpr, startsReadableFlow = false): string {
    const [receiver, name, callback, once, prepend] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || callback?.type.kind !== "func" ||
      once?.type.kind !== "bool" || prepend?.type.kind !== "bool" || expr.args.length !== 5 ||
      !this.isEmitterObject(receiver.type) || !this.isEmitterObject(expr.type)) {
      this.context.unsupported("EventEmitter listener registration shape", expr.loc);
    }
    const shape = this.listenerShape(callback.type, expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    const startFlow = startsReadableFlow
      ? this.startReadableFlow(receiver.type, this.requiredValue(values, 0, expr.loc), expr.loc)
      : "";
    const scheduleReadable = receiver.type.kind === "object" &&
      (receiver.type.className === "%Readable" || this.context.runtimeStreamBase(receiver.type.className) === "%Readable") &&
      name.kind === "strLit" && name.value === "readable"
      ? `sc_readable_schedule_notification(&${this.readableHandle(this.requiredValue(values, 0, expr.loc), receiver.type, expr.loc)});`
      : "";
    return `{ ${this.bindWithRegistry(expr, values)} let sc_identity = ${this.functionIdentity(this.requiredValue(values, 2, expr.loc), callback.type, expr.loc)}; let _ = sc_emitter_emit_meta(&sc_emitter, "newListener", ${values[1]}.clone()); runtime::emitter_on(&sc_emitter, ${values[1]}, ScEmitterListener::${this.listenerVariant(shape)}(${values[2]}), sc_identity, ${values[3]}, ${values[4]}); ${startFlow} ${scheduleReadable} ${values[0]} }`;
  }

  private emitConstructor(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver === undefined || expr.args.length !== 1 || !this.isEmitterObject(receiver.type) ||
      expr.type.kind !== "void") {
      this.context.unsupported("EventEmitter superclass constructor shape", expr.loc);
    }
    return `{ let sc_receiver = ${this.context.emitExpr(receiver)}; let _ = sc_emitter_registry(&sc_receiver); () }`;
  }

  private emitOff(expr: RustLibCallExpr): string {
    const [receiver, name, callback] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || callback?.type.kind !== "func" ||
      expr.args.length !== 3 || !this.isEmitterObject(receiver.type) || !this.isEmitterObject(expr.type)) {
      this.context.unsupported("EventEmitter listener removal shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bindWithRegistry(expr, values)} if runtime::emitter_off(&sc_emitter, &${values[1]}, ${this.functionIdentity(this.requiredValue(values, 2, expr.loc), callback.type, expr.loc)}) { let _ = sc_emitter_emit_meta(&sc_emitter, "removeListener", ${values[1]}.clone()); } ${values[0]} }`;
  }

  private emitCheckListener(expr: RustLibCallExpr): string {
    const [callback] = expr.args;
    if (callback?.type.kind !== "dyn" || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("EventEmitter dynamic listener check shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(callback)}; if sc_dyn_function_identity(&${value}).is_none() { sc_dyn_arg_type_fail("listener", "of type function", &${value}); } () }`;
  }

  private emitOnDynamic(expr: RustLibCallExpr, startsReadableFlow = false): string {
    const [receiver, name, callback, adapter, once, prepend] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || callback?.type.kind !== "dyn" ||
      adapter?.type.kind !== "func" || once?.type.kind !== "bool" || prepend?.type.kind !== "bool" ||
      expr.args.length !== 6 || !this.isEmitterObject(receiver.type) || !this.isEmitterObject(expr.type)) {
      this.context.unsupported("EventEmitter dynamic listener registration shape", expr.loc);
    }
    const shape = this.listenerShape(adapter.type, expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    const startFlow = startsReadableFlow
      ? this.startReadableFlow(receiver.type, this.requiredValue(values, 0, expr.loc), expr.loc)
      : "";
    return `{ ${this.bindWithRegistry(expr, values)} let sc_identity = sc_dyn_function_identity(&${values[2]}).unwrap_or_else(|| sc_dyn_arg_type_fail("listener", "of type function", &${values[2]})); let _ = sc_emitter_emit_meta(&sc_emitter, "newListener", ${values[1]}.clone()); runtime::emitter_on(&sc_emitter, ${values[1]}, ScEmitterListener::${this.listenerVariant(shape)}(${values[3]}), sc_identity, ${values[4]}, ${values[5]}); ${startFlow} ${values[0]} }`;
  }

  private startReadableFlow(type: IrType, value: string, loc: SrcLoc): string {
    if (type.kind !== "object") this.context.unsupported("stream data listener receiver", loc);
    if (type.className === "%Readable") {
      return `runtime::readable_start_flowing(&${value}); sc_readable_schedule(&${value});`;
    }
    if (this.context.runtimeStreamBase(type.className) === "%Readable") {
      const readable = this.readableHandle(value, type, loc);
      return `{ let sc_readable = ${readable}; runtime::readable_start_flowing(&sc_readable); sc_readable_schedule(&sc_readable); }`;
    }
    if (type.className === "%Duplex") return `sc_duplex_start_flowing(&${value});`;
    if (type.className === "%Transform" || type.className === "%PassThrough") {
      return `sc_transform_start_flowing(&${value});`;
    }
    this.context.unsupported(`stream data listener receiver '${type.className}'`, loc);
  }

  private emitOffDynamic(expr: RustLibCallExpr): string {
    const [receiver, name, callback] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || callback?.type.kind !== "dyn" ||
      expr.args.length !== 3 || !this.isEmitterObject(receiver.type) || !this.isEmitterObject(expr.type)) {
      this.context.unsupported("EventEmitter dynamic listener removal shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bindWithRegistry(expr, values)} let sc_identity = sc_dyn_function_identity(&${values[2]}).unwrap_or_else(|| sc_dyn_arg_type_fail("listener", "of type function", &${values[2]})); if runtime::emitter_off(&sc_emitter, &${values[1]}, sc_identity) { let _ = sc_emitter_emit_meta(&sc_emitter, "removeListener", ${values[1]}.clone()); } ${values[0]} }`;
  }

  private emitRemoveAll(expr: RustLibCallExpr): string {
    const [receiver, name, everyEvent] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || everyEvent?.type.kind !== "bool" ||
      expr.args.length !== 3 || !this.isEmitterObject(receiver.type) || !this.isEmitterObject(expr.type)) {
      this.context.unsupported("EventEmitter removeAllListeners shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bindWithRegistry(expr, values)} if ${values[2]} { let sc_names = runtime::emitter_event_names_snapshot(&sc_emitter); for sc_name in sc_names { if sc_name.as_ref() == "removeListener" { continue; } while runtime::emitter_remove_last(&sc_emitter, &sc_name) { let _ = sc_emitter_emit_meta(&sc_emitter, "removeListener", sc_name.clone()); } } let sc_remove_listener = runtime::string("removeListener"); while runtime::emitter_remove_last(&sc_emitter, &sc_remove_listener) { let _ = sc_emitter_emit_meta(&sc_emitter, "removeListener", sc_remove_listener.clone()); } runtime::emitter_remove_all(&sc_emitter, &${values[1]}, true); } else { while runtime::emitter_remove_last(&sc_emitter, &${values[1]}) { let _ = sc_emitter_emit_meta(&sc_emitter, "removeListener", ${values[1]}.clone()); } runtime::emitter_remove_all(&sc_emitter, &${values[1]}, false); } ${values[0]} }`;
  }

  private emitEvent(expr: RustLibCallExpr, unhandledError = false): string {
    const [receiver, name, ...args] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || expr.type.kind !== "bool" ||
      !this.isEmitterObject(receiver.type)) {
      this.context.unsupported("EventEmitter emit shape", expr.loc);
    }
    if (unhandledError && (args.length !== 1 || args[0]?.type.kind !== "object")) {
      this.context.unsupported("EventEmitter error emit shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    const arms: string[] = [];
    for (const shape of this.context.listenerShapes.values()) {
      const passed = this.listenerArguments(shape.type, args, values.slice(2), expr.loc);
      if (passed === null) continue;
      const dispatch = this.context.emitClosureDispatch("sc_callback", shape.type, passed, expr.loc);
      arms.push(`ScEmitterListener::${this.listenerVariant(shape)}(sc_callback) => { let _ = ${dispatch}; },`);
    }
    arms.push("ScEmitterListener::Never => unreachable!(\"scriptc invariant: impossible EventEmitter listener\"),");
    arms.push("_ => unreachable!(\"scriptc invariant: EventEmitter listener signature mismatched its event\"),");
    const errorValue = unhandledError ? this.requiredValue(values, 2, expr.loc) : "";
    const unhandled = unhandledError
      ? `if !sc_had_listeners { runtime::throw_value(${errorValue}.clone()); }`
      : "";
    return `{ ${this.bindWithRegistry(expr, values)} let sc_snapshot = runtime::emitter_snapshot(&sc_emitter, &${values[1]}); let sc_had_listeners = !sc_snapshot.is_empty(); ${unhandled} for sc_registration in sc_snapshot { if !runtime::emitter_listener_should_invoke(&sc_registration) { continue; } if sc_registration.once { let _ = runtime::emitter_remove_registration(&sc_emitter, &${values[1]}, sc_registration.registration); let _ = sc_emitter_emit_meta(&sc_emitter, "removeListener", ${values[1]}.clone()); } match sc_registration.callback { ${arms.join(" ")} } } sc_had_listeners }`;
  }

  private emitCount(expr: RustLibCallExpr): string {
    const [receiver, name] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || expr.args.length !== 2 ||
      expr.type.kind !== "f64" || !this.isEmitterObject(receiver.type)) {
      this.context.unsupported("EventEmitter listenerCount shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bindWithRegistry(expr, values)} runtime::emitter_listener_count(&sc_emitter, &${values[1]}) }`;
  }

  private emitCountIdentity(expr: RustLibCallExpr): string {
    const [receiver, name, callback] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || callback?.type.kind !== "func" ||
      expr.args.length !== 3 || expr.type.kind !== "f64" || !this.isEmitterObject(receiver.type)) {
      this.context.unsupported("EventEmitter listenerCount callback shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bindWithRegistry(expr, values)} runtime::emitter_listener_count_identity(&sc_emitter, &${values[1]}, ${this.functionIdentity(this.requiredValue(values, 2, expr.loc), callback.type, expr.loc)}) }`;
  }

  private emitNames(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver === undefined || expr.args.length !== 1 || !this.isEmitterObject(receiver.type) ||
      expr.type.kind !== "array" || expr.type.elem.kind !== "string") {
      this.context.unsupported("EventEmitter eventNames shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; let sc_emitter = ${this.registry(value, receiver.type, expr.loc)}; runtime::emitter_event_names(&sc_emitter) }`;
  }

  private emitListeners(expr: RustLibCallExpr): string {
    const [receiver, name] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || expr.args.length !== 2 ||
      !this.isEmitterObject(receiver.type) || expr.type.kind !== "array" || expr.type.elem.kind !== "func") {
      this.context.unsupported("EventEmitter listeners snapshot shape", expr.loc);
    }
    const target = this.context.snapshotShapes.get(typeKey(expr.type.elem));
    if (target === undefined) this.context.unsupported("unregistered EventEmitter listeners snapshot", expr.loc);
    const arms: string[] = [];
    for (const source of this.context.listenerShapes.values()) {
      if (!this.snapshotCompatible(source.type, target.type)) continue;
      const variant = `ScEmitterListener::${this.listenerVariant(source)}(callback)`;
      const value = typeKey(source.type) === typeKey(target.type)
        ? "callback"
        : `runtime::Gc::new(${this.context.closureName(target)}::EventAdapter { listener: Some(ScEmitterListener::${this.listenerVariant(source)}(callback)), identity: sc_identity })`;
      arms.push(`${variant} => ${value},`);
    }
    arms.push("_ => unreachable!(\"scriptc invariant: EventEmitter listeners signature mismatched its event\"),");
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bindWithRegistry(expr, values)} let sc_snapshot = runtime::emitter_snapshot(&sc_emitter, &${values[1]}); let mut sc_values = Vec::with_capacity(sc_snapshot.len()); for sc_registration in sc_snapshot { let sc_identity = sc_registration.identity; let sc_callback = match sc_registration.callback { ${arms.join(" ")} }; sc_values.push(sc_callback); } runtime::array_new(sc_values) }`;
  }

  private emitSetMax(expr: RustLibCallExpr): string {
    const [receiver, value] = expr.args;
    if (receiver === undefined || value?.type.kind !== "f64" || expr.args.length !== 2 ||
      !this.isEmitterObject(receiver.type) || !this.isEmitterObject(expr.type)) {
      this.context.unsupported("EventEmitter setMaxListeners shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bindWithRegistry(expr, values)} runtime::emitter_set_max(&sc_emitter, ${values[1]}); ${values[0]} }`;
  }

  private emitSetMaxChecked(expr: RustLibCallExpr): string {
    const [receiver, value] = expr.args;
    if (receiver === undefined || value?.type.kind !== "dyn" || expr.args.length !== 2 ||
      !this.isEmitterObject(receiver.type) || !this.isEmitterObject(expr.type)) {
      this.context.unsupported("EventEmitter checked setMaxListeners shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bindWithRegistry(expr, values)} match &${values[1]} { sc_dyn_value::Number(value) => runtime::emitter_set_max(&sc_emitter, *value), value => sc_dyn_arg_type_fail("setMaxListeners", "of type number", value), } ${values[0]} }`;
  }

  private emitGetMax(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver === undefined || expr.args.length !== 1 || !this.isEmitterObject(receiver.type) ||
      expr.type.kind !== "f64") {
      this.context.unsupported("EventEmitter getMaxListeners shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; let sc_emitter = ${this.registry(value, receiver.type, expr.loc)}; runtime::emitter_get_max(&sc_emitter) }`;
  }

  private emitSetDefaultMax(expr: RustLibCallExpr): string {
    const [value] = expr.args;
    if (value?.type.kind !== "f64" || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("EventEmitter default max-listeners write shape", expr.loc);
    }
    return `runtime::emitter_set_default_max(${this.context.emitExpr(value)})`;
  }

  private emitSetDefaultMaxChecked(expr: RustLibCallExpr): string {
    const [value, name] = expr.args;
    if (value?.type.kind !== "dyn" || name?.type.kind !== "string" || expr.args.length !== 2 ||
      expr.type.kind !== "void") {
      this.context.unsupported("EventEmitter checked default max-listeners shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} match &${values[0]} { sc_dyn_value::Number(value) => runtime::emitter_set_default_max_named(*value, &${values[1]}), value => sc_dyn_arg_type_fail(&${values[1]}, "of type number", value), } }`;
  }

  private emitGetDefaultMax(expr: RustLibCallExpr): string {
    if (expr.args.length !== 0 || expr.type.kind !== "f64") {
      this.context.unsupported("EventEmitter default max-listeners read shape", expr.loc);
    }
    return "runtime::emitter_get_default_max()";
  }

  private emitProcessOnExit(expr: RustLibCallExpr): string {
    const [callback, once] = expr.args;
    if (callback?.type.kind !== "func" || once?.type.kind !== "bool" || expr.args.length !== 2 ||
      expr.type.kind !== "void") {
      this.context.unsupported("process exit listener registration shape", expr.loc);
    }
    const shape = this.listenerShape(callback.type, expr.loc);
    const callbackValue = this.context.nextTemporary();
    const onceValue = this.context.nextTemporary();
    return `{ let ${callbackValue} = ${this.context.emitExpr(callback)}; let ${onceValue} = ${this.context.emitExpr(once)}; let sc_identity = ${this.functionIdentity(callbackValue, callback.type, expr.loc)}; SC_PROCESS_EXIT_LISTENERS.with(|listeners| listeners.borrow_mut().push((ScEmitterListener::${this.listenerVariant(shape)}(${callbackValue}), sc_identity, ${onceValue}))); () }`;
  }

  private emitProcessOffExit(expr: RustLibCallExpr): string {
    const [callback] = expr.args;
    if (callback?.type.kind !== "func" || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("process exit listener removal shape", expr.loc);
    }
    const callbackValue = this.context.nextTemporary();
    return `{ let ${callbackValue} = ${this.context.emitExpr(callback)}; let sc_identity = ${this.functionIdentity(callbackValue, callback.type, expr.loc)}; SC_PROCESS_EXIT_LISTENERS.with(|listeners| { let mut listeners = listeners.borrow_mut(); if let Some(index) = listeners.iter().rposition(|(_, identity, _)| *identity == sc_identity) { listeners.remove(index); } }); () }`;
  }

  private emitProcessExit(expr: RustLibCallExpr): string {
    const [code] = expr.args;
    if (code?.type.kind !== "f64" || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("process exit shape", expr.loc);
    }
    return `sc_process_exit(${this.context.emitExpr(code)})`;
  }

  private emitProcessExitDefinitions(): void {
    if (!this.context.usesProcessExitListeners()) return;
    const loc = this.context.sourceLoc();
    const arms: string[] = [];
    for (const shape of this.context.listenerShapes.values()) {
      if (shape.type.rest === true || shape.type.params.length > 1) continue;
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind !== "f64") continue;
      const args = shape.type.params.length === 0 ? [] : ["sc_code"];
      const dispatch = this.context.emitClosureDispatch("callback", shape.type, args, loc);
      arms.push(`ScEmitterListener::${this.listenerVariant(shape)}(callback) => { let _ = ${dispatch}; },`);
    }
    arms.push("_ => unreachable!(\"scriptc invariant: process exit listener signature\"),");
    this.context.line("thread_local! {");
    this.context.pushIndent();
    this.context.line("static SC_PROCESS_EXIT_LISTENERS: std::cell::RefCell<Vec<(ScEmitterListener, usize, bool)>> = const { std::cell::RefCell::new(Vec::new()) };");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_process_run_exit(sc_code: f64) {");
    this.context.pushIndent();
    this.context.line("let sc_listeners = SC_PROCESS_EXIT_LISTENERS.with(|listeners| std::mem::take(&mut *listeners.borrow_mut()));");
    this.context.line("for (sc_callback, _, _) in sc_listeners {");
    this.context.pushIndent();
    this.context.line(`match sc_callback { ${arms.join(" ")} }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_process_exit(sc_code: f64) -> ! {");
    this.context.pushIndent();
    this.context.line("sc_process_run_exit(sc_code);");
    this.context.line("runtime::process_exit(sc_code)");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("");
  }

  private emitProcessRejectionOn(expr: RustLibCallExpr, unhandled: boolean): string {
    const [callback, once] = expr.args;
    if (callback?.type.kind !== "dyn" || once?.type.kind !== "bool" || expr.args.length !== 2 ||
      expr.type.kind !== "void") {
      this.context.unsupported("process rejection listener registration shape", expr.loc);
    }
    return `sc_process_rejection_on(${unhandled}, ${this.context.emitExpr(callback)}, ${this.context.emitExpr(once)})`;
  }

  private emitProcessRejectionOff(expr: RustLibCallExpr, unhandled: boolean): string {
    const [callback] = expr.args;
    if (callback?.type.kind !== "dyn" || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("process rejection listener removal shape", expr.loc);
    }
    return `sc_process_rejection_off(${unhandled}, ${this.context.emitExpr(callback)})`;
  }

  private emitProcessRejectionDefinitions(): void {
    if (!this.context.usesProcessRejectionEvents()) return;
    const dyn = this.context.dynTypeName();
    this.context.line("#[derive(Clone)]");
    this.context.line(`struct ScProcessRejectionListener { registration: usize, callback: ${dyn}, identity: usize, once: bool }`);
    this.context.line("thread_local! {");
    this.context.pushIndent();
    this.context.line("static SC_PROCESS_UNHANDLED_REJECTION: std::cell::RefCell<Vec<ScProcessRejectionListener>> = const { std::cell::RefCell::new(Vec::new()) };");
    this.context.line("static SC_PROCESS_REJECTION_HANDLED: std::cell::RefCell<Vec<ScProcessRejectionListener>> = const { std::cell::RefCell::new(Vec::new()) };");
    this.context.line("static SC_PROCESS_REJECTION_REGISTRATION: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_process_rejection_sync_hooks() {");
    this.context.pushIndent();
    this.context.line(`if SC_PROCESS_UNHANDLED_REJECTION.with(|listeners| listeners.borrow().is_empty()) { runtime::promise_set_unhandled_rejection_handler(None); } else { runtime::promise_set_unhandled_rejection_handler(Some(std::rc::Rc::new(|reason, promise| sc_process_rejection_fire(true, vec![sc_dyn_from_caught(reason), ${dyn}::Promise(promise)])))); }`);
    this.context.line(`if SC_PROCESS_REJECTION_HANDLED.with(|listeners| listeners.borrow().is_empty()) { runtime::promise_set_rejection_handled_handler(None); } else { runtime::promise_set_rejection_handled_handler(Some(std::rc::Rc::new(|promise| sc_process_rejection_fire(false, vec![${dyn}::Promise(promise)])))); }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_process_rejection_on(unhandled: bool, callback: ${dyn}, once: bool) {`);
    this.context.pushIndent();
    this.context.line("let identity = sc_dyn_function_identity(&callback).unwrap_or_else(|| sc_dyn_arg_type_fail(\"listener\", \"of type function\", &callback));");
    this.context.line("let registration = SC_PROCESS_REJECTION_REGISTRATION.with(|next| { let value = next.get(); next.set(value.checked_add(1).expect(\"scriptc: process rejection registration overflow\")); value });");
    this.context.line("let listener = ScProcessRejectionListener { registration, callback, identity, once };");
    this.context.line("if unhandled { SC_PROCESS_UNHANDLED_REJECTION.with(|listeners| listeners.borrow_mut().push(listener)); } else { SC_PROCESS_REJECTION_HANDLED.with(|listeners| listeners.borrow_mut().push(listener)); }");
    this.context.line("sc_process_rejection_sync_hooks();");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_process_rejection_off(unhandled: bool, callback: ${dyn}) {`);
    this.context.pushIndent();
    this.context.line("let identity = sc_dyn_function_identity(&callback).unwrap_or_else(|| sc_dyn_arg_type_fail(\"listener\", \"of type function\", &callback));");
    this.context.line("let remove = |listeners: &mut Vec<ScProcessRejectionListener>| { if let Some(index) = listeners.iter().rposition(|listener| listener.identity == identity) { listeners.remove(index); } }; ");
    this.context.line("if unhandled { SC_PROCESS_UNHANDLED_REJECTION.with(|listeners| remove(&mut listeners.borrow_mut())); } else { SC_PROCESS_REJECTION_HANDLED.with(|listeners| remove(&mut listeners.borrow_mut())); }");
    this.context.line("sc_process_rejection_sync_hooks();");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_process_rejection_fire(unhandled: bool, args: Vec<${dyn}>) {`);
    this.context.pushIndent();
    this.context.line("let snapshot = if unhandled { SC_PROCESS_UNHANDLED_REJECTION.with(|listeners| listeners.borrow().clone()) } else { SC_PROCESS_REJECTION_HANDLED.with(|listeners| listeners.borrow().clone()) };");
    this.context.line("for listener in snapshot { if listener.once { if unhandled { SC_PROCESS_UNHANDLED_REJECTION.with(|listeners| listeners.borrow_mut().retain(|candidate| candidate.registration != listener.registration)); } else { SC_PROCESS_REJECTION_HANDLED.with(|listeners| listeners.borrow_mut().retain(|candidate| candidate.registration != listener.registration)); } sc_process_rejection_sync_hooks(); } let _ = sc_dyn_call(&listener.callback, &args, \"listener\"); }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_process_rejection_clear() {");
    this.context.pushIndent();
    this.context.line("SC_PROCESS_UNHANDLED_REJECTION.with(|listeners| listeners.borrow_mut().clear());");
    this.context.line("SC_PROCESS_REJECTION_HANDLED.with(|listeners| listeners.borrow_mut().clear());");
    this.context.line("sc_process_rejection_sync_hooks();");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("");
  }

  private emitProcessWarningOn(expr: RustLibCallExpr): string {
    const [callback] = expr.args;
    if (callback?.type.kind !== "dyn" || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("process warning listener registration shape", expr.loc);
    }
    return `sc_process_warning_on(${this.context.emitExpr(callback)})`;
  }

  private emitProcessWarningOff(expr: RustLibCallExpr): string {
    const [callback] = expr.args;
    if (callback?.type.kind !== "dyn" || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("process warning listener removal shape", expr.loc);
    }
    return `sc_process_warning_off(${this.context.emitExpr(callback)})`;
  }

  private emitProcessWarning(expr: RustLibCallExpr): string {
    const [args] = expr.args;
    if (args?.type.kind !== "dyn" || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("process emitWarning argument vector shape", expr.loc);
    }
    return `sc_process_warning_emit(${this.context.emitExpr(args)})`;
  }

  private emitProcessWarningDefinitions(): void {
    if (!this.context.usesProcessWarningEvents()) return;
    const dyn = this.context.dynTypeName();
    const errorValue = this.context.hasErrorClassRoots()
      ? `${this.context.errorValueName()}::Builtin(sc_error)`
      : "sc_error";
    this.context.line("thread_local! {");
    this.context.pushIndent();
    this.context.line(`static SC_PROCESS_WARNING_LISTENERS: std::cell::RefCell<Vec<(${dyn}, usize)>> = const { std::cell::RefCell::new(Vec::new()) };`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_process_warning_is_error(value: &${dyn}) -> bool {`);
    this.context.pushIndent();
    this.context.line(`matches!(value, ${dyn}::Object(object) if runtime::map_has_by(object, &runtime::string("%error"), |left, right| left.as_ref() == right.as_ref()))`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_process_warning_property(value: &${dyn}, key: &str) -> ${dyn} {`);
    this.context.pushIndent();
    this.context.line(`match value { ${dyn}::Object(object) => runtime::map_get_by(object, &runtime::string(key), |left, right| left.as_ref() == right.as_ref()).unwrap_or(${dyn}::Undefined), _ => ${dyn}::Undefined, }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_process_warning_on(callback: ${dyn}) {`);
    this.context.pushIndent();
    this.context.line("let identity = sc_dyn_function_identity(&callback).unwrap_or_else(|| sc_dyn_arg_type_fail(\"listener\", \"of type function\", &callback));");
    this.context.line("SC_PROCESS_WARNING_LISTENERS.with(|listeners| listeners.borrow_mut().push((callback, identity)));");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_process_warning_off(callback: ${dyn}) {`);
    this.context.pushIndent();
    this.context.line("let identity = sc_dyn_function_identity(&callback).unwrap_or_else(|| sc_dyn_arg_type_fail(\"listener\", \"of type function\", &callback));");
    this.context.line("SC_PROCESS_WARNING_LISTENERS.with(|listeners| { let mut listeners = listeners.borrow_mut(); if let Some(index) = listeners.iter().rposition(|(_, candidate)| *candidate == identity) { listeners.remove(index); } });");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_process_warning_dispatch(warning: ${dyn}) {`);
    this.context.pushIndent();
    this.context.line("let listeners = SC_PROCESS_WARNING_LISTENERS.with(|listeners| listeners.borrow().clone());");
    this.context.line("for (listener, _) in listeners { let _ = sc_dyn_call(&listener, &[warning.clone()], \"listener\"); }");
    this.context.line(`let name = match sc_process_warning_property(&warning, "name") { ${dyn}::String(value) => value, _ => runtime::string("Warning"), };`);
    this.context.line(`let message = match sc_process_warning_property(&warning, "message") { ${dyn}::String(value) => value, _ => runtime::empty_string(), };`);
    this.context.line(`let code = match sc_process_warning_property(&warning, "code") { ${dyn}::String(value) => Some(value), _ => None, };`);
    this.context.line(`let detail = match sc_process_warning_property(&warning, "detail") { ${dyn}::String(value) => Some(value), _ => None, };`);
    this.context.line("runtime::process_warning_report(&name, &message, code.as_ref(), detail.as_ref());");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`fn sc_process_warning_emit(args: ${dyn}) {`);
    this.context.pushIndent();
    this.context.line(`let ${dyn}::Array(values) = args else { sc_dyn_arg_type_fail("warning", "of type string or an instance of Error", &args); };`);
    this.context.line(`let argc = runtime::array_len(&values); let warning = if argc > 0.0 { runtime::array_get(&values, 0.0) } else { ${dyn}::Undefined };`);
    this.context.line("if sc_process_warning_is_error(&warning) { sc_process_warning_dispatch(warning); return; }");
    this.context.line(`let message = match warning { ${dyn}::String(value) => value, value => sc_dyn_arg_type_fail("warning", "of type string or an instance of Error", &value), };`);
    this.context.line("let mut name = runtime::string(\"Warning\"); let mut code = None; let mut detail = None; let mut index = 1.0;");
    this.context.line("if index < argc {");
    this.context.pushIndent();
    this.context.line("let value = runtime::array_get(&values, index);");
    this.context.line(`match value { ${dyn}::Undefined => index += 1.0, ${dyn}::String(value) => { name = value; index += 1.0; }, value if sc_dyn_function_identity(&value).is_some() => index = argc, ${dyn}::Object(object) if !runtime::map_has_by(&object, &runtime::string("%error"), |left, right| left.as_ref() == right.as_ref()) => { let type_value = runtime::map_get_by(&object, &runtime::string("type"), |left, right| left.as_ref() == right.as_ref()).unwrap_or(${dyn}::Undefined); match type_value { ${dyn}::Undefined => {}, ${dyn}::String(value) => name = value, value => sc_dyn_prop_type_fail("options.type", "of type string", &value), } if let Some(${dyn}::String(value)) = runtime::map_get_by(&object, &runtime::string("code"), |left, right| left.as_ref() == right.as_ref()) { code = Some(value); } if let Some(${dyn}::String(value)) = runtime::map_get_by(&object, &runtime::string("detail"), |left, right| left.as_ref() == right.as_ref()) { detail = Some(value); } index = argc; }, value => sc_dyn_arg_type_fail("type", "of type string", &value), }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("if index < argc { let value = runtime::array_get(&values, index); match value { " +
      `${dyn}::Undefined => {}, ${dyn}::String(value) => code = Some(value), value if sc_dyn_function_identity(&value).is_some() => {}, value => sc_dyn_arg_type_fail("code", "of type string", &value), } }`);
    this.context.line("let sc_error = if let Some(value) = &code { runtime::error_new_code(name.as_ref(), message.clone(), value.as_ref()) } else { runtime::error_new(name.as_ref(), message.clone()) };");
    this.context.line(`let warning = sc_dyn_error_box(&${errorValue});`);
    this.context.line(`if let (Some(value), ${dyn}::Object(object)) = (detail, &warning) { runtime::map_set_by(object, runtime::string("detail"), ${dyn}::String(value), |left, right| left.as_ref() == right.as_ref()); }`);
    this.context.line("sc_process_warning_dispatch(warning);");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("fn sc_process_warning_clear() { SC_PROCESS_WARNING_LISTENERS.with(|listeners| listeners.borrow_mut().clear()); }");
    this.context.line("");
  }

  private listenerArguments(
    type: IrFuncType,
    args: readonly IrExpr[],
    values: readonly string[],
    loc: SrcLoc,
  ): string[] | null {
    if (type.rest === true || type.params.length > args.length) return null;
    for (let index = 0; index < type.params.length; index += 1) {
      const param = type.params[index];
      const arg = args[index];
      if (param === undefined || arg === undefined || typeKey(param) !== typeKey(arg.type)) return null;
    }
    return type.params.map((param, index) => {
      const value = values[index];
      if (value === undefined) this.context.unsupported("EventEmitter listener argument arity", loc);
      return this.context.needsClone(param) ? `${value}.clone()` : value;
    });
  }

  private emitMetaDispatchHelper(): void {
    const loc = this.context.sourceLoc();
    const arms: string[] = [];
    for (const shape of this.context.listenerShapes.values()) {
      if (shape.type.rest === true || shape.type.params.length > 1) continue;
      if (shape.type.params.length === 1 && shape.type.params[0]?.kind !== "string") continue;
      const args = shape.type.params.length === 0 ? [] : ["sc_event_name.clone()"];
      const dispatch = this.context.emitClosureDispatch("sc_callback", shape.type, args, loc);
      arms.push(`ScEmitterListener::${this.listenerVariant(shape)}(sc_callback) => { let _ = ${dispatch}; },`);
    }
    arms.push("ScEmitterListener::Never => unreachable!(\"scriptc invariant: impossible EventEmitter listener\"),");
    arms.push("_ => unreachable!(\"scriptc invariant: EventEmitter meta-listener signature\"),");
    this.context.line("fn sc_emitter_emit_meta(sc_emitter: &ScEmitterRegistry, sc_meta_name: &str, sc_event_name: runtime::JsString) -> bool {");
    this.context.pushIndent();
    this.context.line("let sc_meta_name = runtime::string(sc_meta_name);");
    this.context.line("let sc_snapshot = runtime::emitter_snapshot(sc_emitter, &sc_meta_name);");
    this.context.line("let sc_had_listeners = !sc_snapshot.is_empty();");
    this.context.line("for sc_registration in sc_snapshot {");
    this.context.pushIndent();
    this.context.line("if !runtime::emitter_listener_should_invoke(&sc_registration) { continue; }");
    this.context.line("if sc_registration.once {");
    this.context.pushIndent();
    this.context.line("let _ = runtime::emitter_remove_registration(sc_emitter, &sc_meta_name, sc_registration.registration);");
    this.context.line("let _ = sc_emitter_emit_meta(sc_emitter, \"removeListener\", sc_meta_name.clone());");
    this.context.popIndent();
    this.context.line("}");
    this.context.line(`match sc_registration.callback { ${arms.join(" ")} }`);
    this.context.popIndent();
    this.context.line("}");
    this.context.line("sc_had_listeners");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("");
  }

  private emitSnapshotDispatchHelpers(): void {
    const loc = this.context.sourceLoc();
    for (const target of this.context.snapshotShapes.values()) {
      const params = target.type.params.map((type, index) =>
        `sc_arg_${index}: ${this.context.rustType(type, loc)}`,
      );
      this.context.line(`fn sc_emitter_dispatch_snapshot_${target.index}(sc_listener: &ScEmitterListener${params.length === 0 ? "" : `, ${params.join(", ")}`}) {`);
      this.context.pushIndent();
      this.context.line("match sc_listener {");
      this.context.pushIndent();
      for (const source of this.context.listenerShapes.values()) {
        if (!this.snapshotCompatible(source.type, target.type)) continue;
        const args = source.type.params.map((type, index) =>
          this.context.needsClone(type) ? `sc_arg_${index}.clone()` : `sc_arg_${index}`,
        );
        const dispatch = this.context.emitClosureDispatch("callback", source.type, args, loc);
        this.context.line(`ScEmitterListener::${this.listenerVariant(source)}(callback) => { let _ = ${dispatch}; },`);
      }
      this.context.line("_ => unreachable!(\"scriptc invariant: EventEmitter snapshot adapter signature\"),");
      this.context.popIndent();
      this.context.line("}");
      this.context.popIndent();
      this.context.line("}");
      this.context.line("");
    }
  }

  private snapshotCompatible(source: IrFuncType, target: IrFuncType): boolean {
    if (source.rest === true || target.rest === true || source.params.length > target.params.length) return false;
    return source.params.every((param, index) => {
      const targetParam = target.params[index];
      return targetParam !== undefined && typeKey(param) === typeKey(targetParam);
    });
  }

  private emitObjectDefinition(): void {
    const roots = this.context.emitterRoots();
    this.context.line("#[derive(Clone)]");
    this.context.line("enum ScEventEmitter {");
    this.context.pushIndent();
    this.context.line("Bare(ScEmitterRegistry),");
    if (this.context.streams.usesReadable) this.context.line("Readable(ScReadable),");
    if (this.context.streams.usesWritable) this.context.line("Writable(ScWritable),");
    if (this.context.streams.usesDuplex) this.context.line("Duplex(ScDuplex),");
    if (this.context.streams.usesTransform) this.context.line("Transform(ScTransform),");
    for (const root of roots) {
      this.context.line(`${this.objectVariant(root)}(runtime::Gc<${this.context.classStructName(root.def.name, root.def.loc)}>),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.line("impl runtime::Trace for ScEventEmitter {");
    this.context.pushIndent();
    this.context.line("fn trace(&self, tracer: &mut runtime::Tracer<'_>) {");
    this.context.pushIndent();
    this.context.line("match self {");
    this.context.pushIndent();
    this.context.line("Self::Bare(value) => tracer.edge(value),");
    if (this.context.streams.usesReadable) this.context.line("Self::Readable(value) => runtime::readable_trace(value, tracer),");
    if (this.context.streams.usesWritable) this.context.line("Self::Writable(value) => runtime::writable_trace(value, tracer),");
    if (this.context.streams.usesDuplex) this.context.line("Self::Duplex(value) => runtime::duplex_trace(value, tracer),");
    if (this.context.streams.usesTransform) this.context.line("Self::Transform(value) => runtime::transform_trace(value, tracer),");
    for (const root of roots) this.context.line(`Self::${this.objectVariant(root)}(value) => tracer.edge(value),`);
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("impl runtime::HeapValue for ScEventEmitter {");
    this.context.pushIndent();
    this.context.line("fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) { runtime::Trace::trace(self, tracer); }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("impl runtime::ArrayElement for ScEventEmitter {");
    this.context.pushIndent();
    this.context.line("fn trace_element(&self, tracer: &mut runtime::Tracer<'_>) { runtime::Trace::trace(self, tracer); }");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("impl PartialEq for ScEventEmitter {");
    this.context.pushIndent();
    this.context.line("fn eq(&self, other: &Self) -> bool {");
    this.context.pushIndent();
    this.context.line("match (self, other) {");
    this.context.pushIndent();
    this.context.line("(Self::Bare(left), Self::Bare(right)) => left.ptr_eq(right),");
    if (this.context.streams.usesReadable) this.context.line("(Self::Readable(left), Self::Readable(right)) => runtime::readable_ptr_eq(left, right),");
    if (this.context.streams.usesWritable) this.context.line("(Self::Writable(left), Self::Writable(right)) => runtime::writable_ptr_eq(left, right),");
    if (this.context.streams.usesDuplex) this.context.line("(Self::Duplex(left), Self::Duplex(right)) => runtime::duplex_ptr_eq(left, right),");
    if (this.context.streams.usesTransform) this.context.line("(Self::Transform(left), Self::Transform(right)) => runtime::transform_ptr_eq(left, right),");
    for (const root of roots) {
      const variant = this.objectVariant(root);
      this.context.line(`(Self::${variant}(left), Self::${variant}(right)) => left.ptr_eq(right),`);
    }
    this.context.line("_ => false,");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
    this.context.line("impl Eq for ScEventEmitter {}");
    this.context.line("fn sc_emitter_registry(value: &ScEventEmitter) -> ScEmitterRegistry {");
    this.context.pushIndent();
    this.context.line("match value {");
    this.context.pushIndent();
    this.context.line("ScEventEmitter::Bare(registry) => registry.clone(),");
    if (this.context.streams.usesReadable) this.context.line("ScEventEmitter::Readable(readable) => runtime::readable_emitter(readable),");
    if (this.context.streams.usesWritable) this.context.line("ScEventEmitter::Writable(writable) => runtime::writable_emitter(writable),");
    if (this.context.streams.usesDuplex) this.context.line("ScEventEmitter::Duplex(duplex) => runtime::duplex_emitter(duplex),");
    if (this.context.streams.usesTransform) this.context.line("ScEventEmitter::Transform(transform) => runtime::transform_emitter(transform),");
    for (const root of roots) {
      this.context.line(`ScEventEmitter::${this.objectVariant(root)}(object) => object.with(|object| object.sc_emitter.as_ref().expect("scriptc: cleared live EventEmitter registry").clone()),`);
    }
    this.context.popIndent();
    this.context.line("}");
    this.context.popIndent();
    this.context.line("}");
  }

  private listenerShape(type: IrFuncType, loc: SrcLoc): RustClosureShape {
    const shape = this.context.listenerShapes.get(typeKey(type));
    if (shape === undefined) this.context.unsupported("unregistered EventEmitter listener signature", loc);
    return shape;
  }

  private functionIdentity(value: string, type: IrFuncType, loc: SrcLoc): string {
    const shape = this.context.closureShapeForType(type, loc);
    return `sc_closure_identity_${shape.index}(&${value})`;
  }

  private bind(args: readonly IrExpr[], values: readonly string[]): string {
    return args.map((arg, index) => `let ${values[index]} = ${this.context.emitExpr(arg)};`).join(" ");
  }

  private bindWithRegistry(expr: RustLibCallExpr, values: readonly string[]): string {
    const receiver = expr.args[0];
    const value = values[0];
    if (receiver === undefined || value === undefined) {
      this.context.unsupported("EventEmitter receiver argument", expr.loc);
    }
    return `${this.bind(expr.args, values)} let sc_emitter = ${this.registry(value, receiver.type, expr.loc)};`;
  }

  private requiredValue(values: readonly string[], index: number, loc: SrcLoc): string {
    const value = values[index];
    if (value === undefined) this.context.unsupported("EventEmitter argument arity", loc);
    return value;
  }

  private listenerVariant(shape: RustClosureShape): string {
    return `Closure${shape.index}`;
  }

  private objectVariant(root: RustClassMeta): string {
    return `User${root.pre}`;
  }

  private classMeta(name: string, loc: SrcLoc): RustClassMeta {
    return this.context.classMeta(name, loc);
  }

  private classPre(name: string, loc: SrcLoc): number {
    return this.classMeta(name, loc).pre;
  }

  private runtimeStreamIsA(source: string, target: string): boolean {
    const seen = new Set<string>();
    let current: string | undefined = source;
    while (current !== undefined && !seen.has(current)) {
      if (current === target) return true;
      seen.add(current);
      current = RUNTIME_STREAM_CLASSES.get(current)?.base;
    }
    return false;
  }

  private isEmitterObject(type: IrType): boolean {
    return type.kind === "object" &&
      (type.className === RUNTIME_EMITTER_CLASS || type.className === "%Readable" || type.className === "%Writable" || type.className === "%Duplex" || type.className === "%Transform" || type.className === "%PassThrough" ||
        this.context.isEmitterClass(type.className) || this.context.runtimeStreamBase(type.className) !== null);
  }

  private registry(value: string, type: IrType, loc: SrcLoc): string {
    if (type.kind !== "object") this.context.unsupported("EventEmitter receiver type", loc);
    if (type.className === RUNTIME_EMITTER_CLASS) return `sc_emitter_registry(&${value})`;
    if (type.className === "%Readable") return `runtime::readable_emitter(&${value})`;
    if (type.className === "%Writable") return `runtime::writable_emitter(&${value})`;
    if (type.className === "%Duplex") return `runtime::duplex_emitter(&${value})`;
    if (type.className === "%Transform") return `runtime::transform_emitter(&${value})`;
    if (type.className === "%PassThrough") return `runtime::transform_emitter(&${value})`;
    if (this.context.runtimeStreamBase(type.className) === "%Readable") {
      return `runtime::readable_emitter(&${this.readableHandle(value, type, loc)})`;
    }
    if (this.context.isEmitterClass(type.className)) {
      return `${value}.with(|object| object.sc_emitter.as_ref().expect("scriptc: cleared live EventEmitter registry").clone())`;
    }
    this.context.unsupported(`non-EventEmitter receiver '${type.className}'`, loc);
  }

  private readableHandle(value: string, type: IrType, loc: SrcLoc): string {
    if (type.kind !== "object") this.context.unsupported("Readable receiver type", loc);
    if (type.className === "%Readable") return value;
    if (this.context.runtimeStreamBase(type.className) !== "%Readable") {
      this.context.unsupported("Readable subclass receiver", loc);
    }
    return `${value}.with(|object| object.sc_readable.as_ref().expect("scriptc: uninitialized Readable subclass").clone())`;
  }

  private isBareEmitter(type: IrType): boolean {
    return type.kind === "object" && type.className === RUNTIME_EMITTER_CLASS;
  }
}
