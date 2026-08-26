import type { IrExpr, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_EMITTER_CLASS, typeKey } from "../../ir/nodes.js";
import type { IrFuncType, RustClassMeta, RustClosureShape } from "./model.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustEventEmitterContext {
  readonly listenerShapes: ReadonlyMap<string, RustClosureShape>;
  readonly snapshotShapes: ReadonlyMap<string, RustClosureShape>;
  emitterRoots(): RustClassMeta[];
  classMeta(name: string, loc?: SrcLoc): RustClassMeta;
  isEmitterClass(name: string): boolean;
  isUsed(): boolean;
  usesProcessExitListeners(): boolean;
  usesProcessRejectionEvents(): boolean;
  usesReadable(): boolean;
  readonly readableReadShapes: ReadonlyMap<string, RustClosureShape>;
  dynTypeName(): string;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextTemporary(): string;
  emitExpr(expr: IrExpr): string;
  closureName(shape: RustClosureShape): string;
  classStructName(name: string, loc?: SrcLoc): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  sourceLoc(): SrcLoc;
  needsClone(type: IrType): boolean;
  rustString(value: string): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit the module-specialized, strongly typed EventEmitter bridge. */
export class RustEventEmitterEmitter {
  constructor(private readonly context: RustEventEmitterContext) {}

  emitDefinition(): void {
    if (!this.context.isUsed()) return;
    this.context.line("#[derive(Clone)]");
    this.context.line("enum ScEmitterListener {");
    this.context.pushIndent();
    this.context.line("Never,");
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
    this.emitReadableTypeDefinition();
    this.emitObjectDefinition();
    this.context.line("");
    this.emitMetaDispatchHelper();
    this.emitSnapshotDispatchHelpers();
    this.emitProcessExitDefinitions();
    this.emitProcessRejectionDefinitions();
    this.emitReadableDefinitions();
  }

  emitUpcast(value: string, source: IrType, loc: SrcLoc): string | null {
    if (source.kind === "object" && source.className === "%Readable") {
      return `ScEventEmitter::Readable(${value})`;
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
      case "readable.new": return this.emitReadableNew(expr);
      case "readable.push": return this.emitReadablePush(expr, false);
      case "readable.pushStr": return this.emitReadablePush(expr, true);
      case "readable.pushNull": return this.emitReadablePushNull(expr);
      case "readable.read": return this.emitReadableRead(expr);
      case "readable.unshift": return this.emitReadableUnshift(expr);
      case "readable.pause": return this.emitReadablePause(expr);
      case "readable.resume": return this.emitReadableResume(expr);
      case "readable.isPaused": return this.emitReadableIsPaused(expr);
      case "readable.flowing": return this.emitReadableFlowing(expr);
      case "stream.prop": return this.emitReadableProp(expr);
      case "stream.destroyErr": return this.emitReadableDestroyError(expr);
      default: return null;
    }
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
      ? `runtime::readable_start_flowing(&${values[0]}); sc_readable_schedule(&${values[0]});`
      : "";
    const scheduleReadable = receiver.type.kind === "object" && receiver.type.className === "%Readable" &&
      name.kind === "strLit" && name.value === "readable" ? `sc_readable_schedule_notification(&${values[0]});` : "";
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

  private emitOnDynamic(expr: RustLibCallExpr): string {
    const [receiver, name, callback, adapter, once, prepend] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || callback?.type.kind !== "dyn" ||
      adapter?.type.kind !== "func" || once?.type.kind !== "bool" || prepend?.type.kind !== "bool" ||
      expr.args.length !== 6 || !this.isEmitterObject(receiver.type) || !this.isEmitterObject(expr.type)) {
      this.context.unsupported("EventEmitter dynamic listener registration shape", expr.loc);
    }
    const shape = this.listenerShape(adapter.type, expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bindWithRegistry(expr, values)} let sc_identity = sc_dyn_function_identity(&${values[2]}).unwrap_or_else(|| sc_dyn_arg_type_fail("listener", "of type function", &${values[2]})); let _ = sc_emitter_emit_meta(&sc_emitter, "newListener", ${values[1]}.clone()); runtime::emitter_on(&sc_emitter, ${values[1]}, ScEmitterListener::${this.listenerVariant(shape)}(${values[3]}), sc_identity, ${values[4]}, ${values[5]}); ${values[0]} }`;
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
    return `{ ${this.bindWithRegistry(expr, values)} if ${values[2]} { let sc_names = runtime::emitter_event_names_snapshot(&sc_emitter); for sc_name in sc_names { if sc_name.as_ref() == "removeListener" { continue; } while runtime::emitter_remove_last(&sc_emitter, &sc_name) { let _ = sc_emitter_emit_meta(&sc_emitter, "removeListener", sc_name.clone()); } } let sc_remove_listener = runtime::string("removeListener"); while runtime::emitter_remove_last(&sc_emitter, &sc_remove_listener) { let _ = sc_emitter_emit_meta(&sc_emitter, "removeListener", sc_remove_listener.clone()); } } else { while runtime::emitter_remove_last(&sc_emitter, &${values[1]}) { let _ = sc_emitter_emit_meta(&sc_emitter, "removeListener", ${values[1]}.clone()); } } ${values[0]} }`;
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

  private emitReadableNew(expr: RustLibCallExpr): string {
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

  private emitReadablePush(expr: RustLibCallExpr, stringChunk: boolean): string {
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

  private emitReadablePushNull(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      expr.args.length !== 1 || expr.type.kind !== "bool") {
      this.context.unsupported("Readable null push shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; let sc_result = runtime::readable_push_null(&${value}); sc_readable_schedule(&${value}); sc_readable_schedule_notification(&${value}); sc_result }`;
  }

  private emitReadableRead(expr: RustLibCallExpr): string {
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

  private emitReadableUnshift(expr: RustLibCallExpr): string {
    const [receiver, chunk] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      chunk?.type.kind !== "bytes" || chunk.type.elem !== "u8" || expr.args.length !== 2 ||
      expr.type.kind !== "void") {
      this.context.unsupported("Readable unshift shape", expr.loc);
    }
    return `runtime::readable_unshift(&(${this.context.emitExpr(receiver)}), ${this.context.emitExpr(chunk)})`;
  }

  private emitReadableProp(expr: RustLibCallExpr): string {
    const [receiver, name] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      name?.type.kind !== "string" || expr.args.length !== 2 || expr.type.kind !== "f64") {
      this.context.unsupported("Readable numeric property shape", expr.loc);
    }
    return `runtime::readable_prop(&(${this.context.emitExpr(receiver)}), &(${this.context.emitExpr(name)}))`;
  }

  private emitReadablePause(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      expr.args.length !== 1 || expr.type.kind !== "object" || expr.type.className !== "%Readable") {
      this.context.unsupported("Readable pause shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; if runtime::readable_pause(&${value}) { sc_readable_emit_void(&${value}, "pause"); } ${value} }`;
  }

  private emitReadableResume(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      expr.args.length !== 1 || expr.type.kind !== "object" || expr.type.className !== "%Readable") {
      this.context.unsupported("Readable resume shape", expr.loc);
    }
    const value = this.context.nextTemporary();
    return `{ let ${value} = ${this.context.emitExpr(receiver)}; runtime::readable_resume(&${value}); sc_readable_schedule(&${value}); ${value} }`;
  }

  private emitReadableIsPaused(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver?.type.kind !== "object" || receiver.type.className !== "%Readable" ||
      expr.args.length !== 1 || expr.type.kind !== "bool") {
      this.context.unsupported("Readable isPaused shape", expr.loc);
    }
    return `runtime::readable_is_paused(&(${this.context.emitExpr(receiver)}))`;
  }

  private emitReadableDestroyError(expr: RustLibCallExpr): string {
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

  private emitReadableFlowing(expr: RustLibCallExpr): string {
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

  private emitReadableTypeDefinition(): void {
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

  private emitReadableDefinitions(): void {
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

  private emitObjectDefinition(): void {
    const roots = this.context.emitterRoots();
    this.context.line("#[derive(Clone)]");
    this.context.line("enum ScEventEmitter {");
    this.context.pushIndent();
    this.context.line("Bare(ScEmitterRegistry),");
    if (this.context.usesReadable()) this.context.line("Readable(ScReadable),");
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
    if (this.context.usesReadable()) this.context.line("Self::Readable(value) => runtime::readable_trace(value, tracer),");
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
    if (this.context.usesReadable()) this.context.line("(Self::Readable(left), Self::Readable(right)) => runtime::readable_ptr_eq(left, right),");
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
    if (this.context.usesReadable()) this.context.line("ScEventEmitter::Readable(readable) => runtime::readable_emitter(readable),");
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

  private isEmitterObject(type: IrType): boolean {
    return type.kind === "object" &&
      (type.className === RUNTIME_EMITTER_CLASS || type.className === "%Readable" ||
        this.context.isEmitterClass(type.className));
  }

  private registry(value: string, type: IrType, loc: SrcLoc): string {
    if (type.kind !== "object") this.context.unsupported("EventEmitter receiver type", loc);
    if (type.className === RUNTIME_EMITTER_CLASS) return `sc_emitter_registry(&${value})`;
    if (type.className === "%Readable") return `runtime::readable_emitter(&${value})`;
    if (this.context.isEmitterClass(type.className)) {
      return `${value}.with(|object| object.sc_emitter.as_ref().expect("scriptc: cleared live EventEmitter registry").clone())`;
    }
    this.context.unsupported(`non-EventEmitter receiver '${type.className}'`, loc);
  }

  private isBareEmitter(type: IrType): boolean {
    return type.kind === "object" && type.className === RUNTIME_EMITTER_CLASS;
  }
}
