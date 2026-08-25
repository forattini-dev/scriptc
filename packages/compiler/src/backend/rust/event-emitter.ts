import type { IrExpr, IrType, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_EMITTER_CLASS, typeKey } from "../../ir/nodes.js";
import type { IrFuncType, RustClosureShape } from "./model.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustEventEmitterContext {
  readonly listenerShapes: ReadonlyMap<string, RustClosureShape>;
  isUsed(): boolean;
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextTemporary(): string;
  emitExpr(expr: IrExpr): string;
  closureName(shape: RustClosureShape): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  sourceLoc(): SrcLoc;
  needsClone(type: IrType): boolean;
  rustString(value: string): string;
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
    this.context.line("type ScEventEmitter = runtime::JsEventEmitter<ScEmitterListener>;");
    this.context.line("");
    this.emitMetaDispatchHelper();
  }

  emitLibCall(expr: RustLibCallExpr): string | null {
    switch (expr.fn) {
      case "emitter.new":
        if (expr.args.length !== 0 || !this.isBareEmitter(expr.type)) {
          this.context.unsupported("EventEmitter constructor shape", expr.loc);
        }
        return "runtime::emitter_new::<ScEmitterListener>()";
      case "emitter.on": return this.emitOn(expr);
      case "emitter.off": return this.emitOff(expr);
      case "emitter.removeAll": return this.emitRemoveAll(expr);
      case "emitter.emit": return this.emitEvent(expr);
      case "emitter.emitError": return this.emitEvent(expr, true);
      case "emitter.count": return this.emitCount(expr);
      case "emitter.countFn": return this.emitCountIdentity(expr);
      case "emitter.names": return this.emitNames(expr);
      case "emitter.setMax": return this.emitSetMax(expr);
      case "emitter.getMax": return this.emitGetMax(expr);
      case "emitter.setDefaultMax": return this.emitSetDefaultMax(expr);
      case "emitter.getDefaultMax": return this.emitGetDefaultMax(expr);
      default: return null;
    }
  }

  private emitOn(expr: RustLibCallExpr): string {
    const [receiver, name, callback, once, prepend] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || callback?.type.kind !== "func" ||
      once?.type.kind !== "bool" || prepend?.type.kind !== "bool" || expr.args.length !== 5 ||
      !this.isBareEmitter(receiver.type) || !this.isBareEmitter(expr.type)) {
      this.context.unsupported("EventEmitter listener registration shape", expr.loc);
    }
    const shape = this.listenerShape(callback.type, expr.loc);
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} let sc_identity = ${values[2]}.identity(); let _ = sc_emitter_emit_meta(&${values[0]}, "newListener", ${values[1]}.clone()); runtime::emitter_on(&${values[0]}, ${values[1]}, ScEmitterListener::${this.listenerVariant(shape)}(${values[2]}), sc_identity, ${values[3]}, ${values[4]}); ${values[0]} }`;
  }

  private emitOff(expr: RustLibCallExpr): string {
    const [receiver, name, callback] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || callback?.type.kind !== "func" ||
      expr.args.length !== 3 || !this.isBareEmitter(receiver.type) || !this.isBareEmitter(expr.type)) {
      this.context.unsupported("EventEmitter listener removal shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} if runtime::emitter_off(&${values[0]}, &${values[1]}, ${values[2]}.identity()) { let _ = sc_emitter_emit_meta(&${values[0]}, "removeListener", ${values[1]}.clone()); } ${values[0]} }`;
  }

  private emitRemoveAll(expr: RustLibCallExpr): string {
    const [receiver, name, everyEvent] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || everyEvent?.type.kind !== "bool" ||
      expr.args.length !== 3 || !this.isBareEmitter(receiver.type) || !this.isBareEmitter(expr.type)) {
      this.context.unsupported("EventEmitter removeAllListeners shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} if ${values[2]} { let sc_names = runtime::emitter_event_names_snapshot(&${values[0]}); for sc_name in sc_names { if sc_name.as_ref() == "removeListener" { continue; } while runtime::emitter_remove_last(&${values[0]}, &sc_name) { let _ = sc_emitter_emit_meta(&${values[0]}, "removeListener", sc_name.clone()); } } let sc_remove_listener = runtime::string("removeListener"); while runtime::emitter_remove_last(&${values[0]}, &sc_remove_listener) { let _ = sc_emitter_emit_meta(&${values[0]}, "removeListener", sc_remove_listener.clone()); } } else { while runtime::emitter_remove_last(&${values[0]}, &${values[1]}) { let _ = sc_emitter_emit_meta(&${values[0]}, "removeListener", ${values[1]}.clone()); } } ${values[0]} }`;
  }

  private emitEvent(expr: RustLibCallExpr, unhandledError = false): string {
    const [receiver, name, ...args] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || expr.type.kind !== "bool" ||
      !this.isBareEmitter(receiver.type)) {
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
    return `{ ${this.bind(expr.args, values)} let sc_snapshot = runtime::emitter_snapshot(&${values[0]}, &${values[1]}); let sc_had_listeners = !sc_snapshot.is_empty(); ${unhandled} for sc_registration in sc_snapshot { if !runtime::emitter_listener_should_invoke(&sc_registration) { continue; } if sc_registration.once { let _ = runtime::emitter_remove_registration(&${values[0]}, &${values[1]}, sc_registration.registration); let _ = sc_emitter_emit_meta(&${values[0]}, "removeListener", ${values[1]}.clone()); } match sc_registration.callback { ${arms.join(" ")} } } sc_had_listeners }`;
  }

  private emitCount(expr: RustLibCallExpr): string {
    const [receiver, name] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || expr.args.length !== 2 ||
      expr.type.kind !== "f64" || !this.isBareEmitter(receiver.type)) {
      this.context.unsupported("EventEmitter listenerCount shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} runtime::emitter_listener_count(&${values[0]}, &${values[1]}) }`;
  }

  private emitCountIdentity(expr: RustLibCallExpr): string {
    const [receiver, name, callback] = expr.args;
    if (receiver === undefined || name?.type.kind !== "string" || callback?.type.kind !== "func" ||
      expr.args.length !== 3 || expr.type.kind !== "f64" || !this.isBareEmitter(receiver.type)) {
      this.context.unsupported("EventEmitter listenerCount callback shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} runtime::emitter_listener_count_identity(&${values[0]}, &${values[1]}, ${values[2]}.identity()) }`;
  }

  private emitNames(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver === undefined || expr.args.length !== 1 || !this.isBareEmitter(receiver.type) ||
      expr.type.kind !== "array" || expr.type.elem.kind !== "string") {
      this.context.unsupported("EventEmitter eventNames shape", expr.loc);
    }
    return `runtime::emitter_event_names(&(${this.context.emitExpr(receiver)}))`;
  }

  private emitSetMax(expr: RustLibCallExpr): string {
    const [receiver, value] = expr.args;
    if (receiver === undefined || value?.type.kind !== "f64" || expr.args.length !== 2 ||
      !this.isBareEmitter(receiver.type) || !this.isBareEmitter(expr.type)) {
      this.context.unsupported("EventEmitter setMaxListeners shape", expr.loc);
    }
    const values = expr.args.map(() => this.context.nextTemporary());
    return `{ ${this.bind(expr.args, values)} runtime::emitter_set_max(&${values[0]}, ${values[1]}); ${values[0]} }`;
  }

  private emitGetMax(expr: RustLibCallExpr): string {
    const [receiver] = expr.args;
    if (receiver === undefined || expr.args.length !== 1 || !this.isBareEmitter(receiver.type) ||
      expr.type.kind !== "f64") {
      this.context.unsupported("EventEmitter getMaxListeners shape", expr.loc);
    }
    return `runtime::emitter_get_max(&(${this.context.emitExpr(receiver)}))`;
  }

  private emitSetDefaultMax(expr: RustLibCallExpr): string {
    const [value] = expr.args;
    if (value?.type.kind !== "f64" || expr.args.length !== 1 || expr.type.kind !== "void") {
      this.context.unsupported("EventEmitter default max-listeners write shape", expr.loc);
    }
    return `runtime::emitter_set_default_max(${this.context.emitExpr(value)})`;
  }

  private emitGetDefaultMax(expr: RustLibCallExpr): string {
    if (expr.args.length !== 0 || expr.type.kind !== "f64") {
      this.context.unsupported("EventEmitter default max-listeners read shape", expr.loc);
    }
    return "runtime::emitter_get_default_max()";
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
    this.context.line("fn sc_emitter_emit_meta(sc_emitter: &ScEventEmitter, sc_meta_name: &str, sc_event_name: runtime::JsString) -> bool {");
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

  private listenerShape(type: IrFuncType, loc: SrcLoc): RustClosureShape {
    const shape = this.context.listenerShapes.get(typeKey(type));
    if (shape === undefined) this.context.unsupported("unregistered EventEmitter listener signature", loc);
    return shape;
  }

  private bind(args: readonly IrExpr[], values: readonly string[]): string {
    return args.map((arg, index) => `let ${values[index]} = ${this.context.emitExpr(arg)};`).join(" ");
  }

  private requiredValue(values: readonly string[], index: number, loc: SrcLoc): string {
    const value = values[index];
    if (value === undefined) this.context.unsupported("EventEmitter argument arity", loc);
    return value;
  }

  private listenerVariant(shape: RustClosureShape): string {
    return `Closure${shape.index}`;
  }

  private isBareEmitter(type: IrType): boolean {
    return type.kind === "object" && type.className === RUNTIME_EMITTER_CLASS;
  }
}
