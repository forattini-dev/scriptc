import type { IrExpr, IrType, SrcLoc } from "../../ir/nodes.js";
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
    this.emitObjectDefinition();
    this.context.line("");
    this.emitMetaDispatchHelper();
    this.emitSnapshotDispatchHelpers();
    this.emitProcessExitDefinitions();
  }

  emitUpcast(value: string, source: IrType, loc: SrcLoc): string | null {
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
      default: return null;
    }
  }

  private emitOn(expr: RustLibCallExpr): string {
    const [receiver, name, callback, once, prepend] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || callback?.type.kind !== "func" ||
      once?.type.kind !== "bool" || prepend?.type.kind !== "bool" || expr.args.length !== 5 ||
      !this.isEmitterObject(receiver.type) || !this.isEmitterObject(expr.type)) {
      this.context.unsupported("EventEmitter listener registration shape", expr.loc);
    }
    const shape = this.listenerShape(callback.type, expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bindWithRegistry(expr, values)} let sc_identity = ${this.functionIdentity(this.requiredValue(values, 2, expr.loc), callback.type, expr.loc)}; let _ = sc_emitter_emit_meta(&sc_emitter, "newListener", ${values[1]}.clone()); runtime::emitter_on(&sc_emitter, ${values[1]}, ScEmitterListener::${this.listenerVariant(shape)}(${values[2]}), sc_identity, ${values[3]}, ${values[4]}); ${values[0]} }`;
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
      (type.className === RUNTIME_EMITTER_CLASS || this.context.isEmitterClass(type.className));
  }

  private registry(value: string, type: IrType, loc: SrcLoc): string {
    if (type.kind !== "object") this.context.unsupported("EventEmitter receiver type", loc);
    if (type.className === RUNTIME_EMITTER_CLASS) return `sc_emitter_registry(&${value})`;
    if (this.context.isEmitterClass(type.className)) {
      return `${value}.with(|object| object.sc_emitter.as_ref().expect("scriptc: cleared live EventEmitter registry").clone())`;
    }
    this.context.unsupported(`non-EventEmitter receiver '${type.className}'`, loc);
  }

  private isBareEmitter(type: IrType): boolean {
    return type.kind === "object" && type.className === RUNTIME_EMITTER_CLASS;
  }
}
