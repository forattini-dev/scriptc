import type { IrExpr, IrType, SrcLoc } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import type { IrFuncType } from "./model.js";
import { RustStreamPromiseEmitter } from "./stream-promises.js";

type RustLibCallExpr = Extract<IrExpr, { kind: "libCall" }>;

export interface RustStreamPipeContext {
  nextTemporary(): string;
  emitExpr(expr: IrExpr): string;
  dynTypeName(): string;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  runtimeStreamBase(name: string): "%Readable" | "%Writable" | "%Duplex" | "%Transform" | null;
  unsupported(kind: string, loc?: SrcLoc): never;
}

/** Emit Readable piping and callback/promise pipeline expressions. */
export class RustStreamPipeEmitter {
  constructor(
    private readonly context: RustStreamPipeContext,
    private readonly promises: RustStreamPromiseEmitter,
  ) {}

  emitLibCall(expr: RustLibCallExpr): string | null {
    switch (expr.fn) {
      case "readable.pipe": return this.emitPipe(expr);
      case "readable.unpipe": return this.emitUnpipe(expr);
      case "stream.pipeline":
      case "stream.pipelineDyn": return this.emitCallbackPipeline(expr);
      case "sp.pipeline": return this.emitPromisePipeline(expr);
      default: return null;
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
      return this.promises.streamValue(stream.type, `${value}.clone()`, expr.loc);
    }).join(", ");
    return `{ ${bindings} ${pipes} sc_stream_promise_pipeline(vec![${wrapped}]) }`;
  }

  private emitCallbackPipeline(expr: RustLibCallExpr): string {
    const count = expr.args[0];
    const dynamic = expr.fn === "stream.pipelineDyn";
    if ((expr.fn !== "stream.pipeline" && !dynamic) || count?.kind !== "numLit" ||
      !Number.isInteger(count.value) || count.value < 2 ||
      expr.args.length !== count.value + 2) {
      this.context.unsupported("dynamic stream pipeline shape", expr.loc);
    }
    const streams = expr.args.slice(1, -1);
    const callback = expr.args.at(-1);
    const destination = streams.at(-1);
    if (callback === undefined || destination === undefined || destination.type.kind !== "object" ||
      (dynamic ? callback?.type.kind !== "dyn" : callback?.type.kind !== "func") ||
      typeKey(expr.type) !== typeKey(destination.type)) {
      this.context.unsupported("dynamic stream pipeline callback", expr.loc);
    }
    const values = streams.map(() => this.context.nextTemporary());
    const callbackValue = this.context.nextTemporary();
    const bindings = [
      ...streams.map((stream, index) => `let ${values[index]} = ${this.context.emitExpr(stream)};`),
      `let ${callbackValue} = ${this.context.emitExpr(callback)};`,
    ].join(" ");
    const pipes = streams.slice(0, -1).map((source, index) => {
      const next = streams[index + 1];
      const sourceValue = values[index];
      const destinationValue = values[index + 1];
      if (next === undefined || sourceValue === undefined || destinationValue === undefined) {
        this.context.unsupported("dynamic stream pipeline stages", expr.loc);
      }
      return this.emitPipeBound(source.type, next.type, sourceValue, destinationValue, "true", expr.loc);
    }).join(" ");
    const wrapped = streams.map((stream, index) => {
      const value = values[index];
      if (value === undefined) this.context.unsupported("dynamic stream pipeline stage", expr.loc);
      return this.promises.streamValue(stream.type, `${value}.clone()`, expr.loc);
    }).join(", ");
    const destinationValue = values.at(-1);
    if (destinationValue === undefined) this.context.unsupported("dynamic stream pipeline destination", expr.loc);
    let context: string;
    let invoke: string;
    let trace: string;
    if (callback.type.kind === "dyn") {
      const dyn = this.context.dynTypeName();
      context = callbackValue;
      invoke = `let sc_args = match sc_error { Some(sc_error) => vec![sc_dyn_error_box(&sc_error)], None => Vec::<${dyn}>::new(), }; let _ = sc_dyn_call(sc_context.as_ref(), &sc_args, "callback");`;
      trace = "runtime::Trace::trace(sc_context.as_ref(), tracer);";
    } else {
      if (callback.type.kind !== "func") {
        this.context.unsupported("typed stream pipeline callback", expr.loc);
      }
      const callbackType = callback.type;
      const first = callbackType.params[0];
      if (callbackType.ret.kind !== "void" || callbackType.rest === true ||
        callbackType.params.length < 1 || callbackType.params.length > 2 ||
        first?.kind !== "object" || first.className !== destination.type.className) {
        this.context.unsupported("typed stream pipeline callback signature", expr.loc);
      }
      const args = ["sc_context.1.clone()"];
      const status = callbackType.params[1];
      if (status !== undefined) {
        args.push(this.promises.callbackStatus(status, "sc_error", expr.loc));
      }
      context = `(${callbackValue}, ${destinationValue}.clone())`;
      invoke = `let _ = ${this.context.emitClosureDispatch("sc_context.0", callbackType, args, expr.loc)};`;
      trace = "tracer.edge(&sc_context.0); tracer.edge(&sc_context.1);";
    }
    return `{ ${bindings} ${pipes} let sc_context = std::rc::Rc::new(${context}); sc_stream_callback_pipeline(vec![${wrapped}], std::rc::Rc::new({ let sc_context = sc_context.clone(); move |sc_error| { ${invoke} } }), std::rc::Rc::new(move |tracer| { ${trace} })); ${destinationValue} }`;
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
    const write = this.pipeWrite(destinationType.className, loc);
    const finish = this.pipeEnd(destinationType.className, loc);
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
    const base = this.context.runtimeStreamBase(className);
    if (base === "%Readable") return `${value}.with(|object| object.sc_readable.as_ref().expect("scriptc: uninitialized Readable subclass").clone())`;
    if (base === "%Duplex") return `runtime::duplex_readable(&${this.duplexHandle(value, className, loc)})`;
    if (base === "%Transform") return `runtime::transform_readable(&${this.transformHandle(value, className, loc)})`;
    this.context.unsupported(`pipe source '${className}'`, loc);
  }

  private pipeWrite(className: string, loc: SrcLoc): string {
    if (className === "%Writable") {
      return "let sc_result = runtime::writable_enqueue(&sc_destination, sc_chunk, ScWritableDone::Never); sc_writable_drain_queue(&sc_destination); sc_result";
    }
    if (className === "%Transform" || className === "%PassThrough") {
      return "let sc_writable = runtime::transform_writable(&sc_destination); let sc_result = runtime::writable_enqueue(&sc_writable, sc_chunk, ScTransformDone::Never); sc_transform_drain_write(&sc_destination); sc_result";
    }
    if (className === "%Duplex") {
      return "let sc_writable = runtime::duplex_writable(&sc_destination); let sc_result = runtime::writable_enqueue(&sc_writable, sc_chunk, ScDuplexDone::Never); sc_duplex_write_drain(&sc_destination); sc_result";
    }
    const base = this.context.runtimeStreamBase(className);
    if (base === "%Writable") return "let sc_writable = sc_destination.with(|object| object.sc_writable.as_ref().expect(\"scriptc: uninitialized Writable subclass\").clone()); let _ = runtime::writable_enqueue(&sc_writable, sc_chunk, ScWritableDone::Never); sc_writable_drain_queue(&sc_writable); runtime::writable_write_result(&sc_writable)";
    if (base === "%Duplex") return "let sc_duplex = sc_destination.with(|object| object.sc_duplex.as_ref().expect(\"scriptc: uninitialized Duplex subclass\").clone()); let sc_writable = runtime::duplex_writable(&sc_duplex); let _ = runtime::writable_enqueue(&sc_writable, sc_chunk, ScDuplexDone::Never); sc_duplex_write_drain(&sc_duplex); runtime::writable_write_result(&sc_writable)";
    if (base === "%Transform") return "let sc_transform = sc_destination.with(|object| object.sc_transform.as_ref().expect(\"scriptc: uninitialized Transform subclass\").clone()); let sc_writable = runtime::transform_writable(&sc_transform); let _ = runtime::writable_enqueue(&sc_writable, sc_chunk, ScTransformDone::Never); sc_transform_drain_write(&sc_transform); runtime::writable_write_result(&sc_writable)";
    this.context.unsupported(`pipe destination '${className}'`, loc);
  }

  private pipeEnd(className: string, loc: SrcLoc): string {
    if (className === "%Writable") return "sc_writable_end_from_pipe(&sc_destination);";
    if (className === "%Transform" || className === "%PassThrough") {
      return "sc_transform_end_from_pipe(&sc_destination);";
    }
    const base = this.context.runtimeStreamBase(className);
    if (base === "%Writable") return "let sc_writable = sc_destination.with(|object| object.sc_writable.as_ref().expect(\"scriptc: uninitialized Writable subclass\").clone()); sc_writable_end_from_pipe(&sc_writable);";
    if (base === "%Transform") return "let sc_transform = sc_destination.with(|object| object.sc_transform.as_ref().expect(\"scriptc: uninitialized Transform subclass\").clone()); sc_transform_end_from_pipe(&sc_transform);";
    this.context.unsupported(`pipe end destination '${className}'`, loc);
  }

  private pipeEvent(value: string, className: string, event: string, loc: SrcLoc): string {
    const receiver = `&${value}`;
    if (className === "%Writable") return `sc_writable_emit_void(${receiver}, "${event}");`;
    if (className === "%Transform" || className === "%PassThrough") {
      return `sc_transform_emit_void(${receiver}, "${event}");`;
    }
    if (className === "%Duplex") return `sc_duplex_emit_void(${receiver}, "${event}");`;
    const base = this.context.runtimeStreamBase(className);
    if (base === "%Writable") return `{ let sc_writable = ${this.writableHandle(value, className, loc)}; sc_writable_emit_void(&sc_writable, "${event}"); }`;
    if (base === "%Duplex") return `{ let sc_duplex = ${this.duplexHandle(value, className, loc)}; sc_duplex_emit_void(&sc_duplex, "${event}"); }`;
    if (base === "%Transform") return `{ let sc_transform = ${this.transformHandle(value, className, loc)}; sc_transform_emit_void(&sc_transform, "${event}"); }`;
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
    const base = this.context.runtimeStreamBase(className);
    if (base === "%Readable") return `{ let sc_readable = ${value}.with(|object| object.sc_readable.as_ref().expect("scriptc: uninitialized Readable subclass").clone()); runtime::readable_start_flowing(&sc_readable); sc_readable_schedule(&sc_readable); }`;
    if (base === "%Duplex") return `{ let sc_duplex = ${this.duplexHandle(value, className, loc)}; sc_duplex_start_flowing(&sc_duplex); }`;
    if (base === "%Transform") return `{ let sc_transform = ${this.transformHandle(value, className, loc)}; sc_transform_start_flowing(&sc_transform); }`;
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
    const base = this.context.runtimeStreamBase(className);
    if (base === "%Readable") return "let sc_readable = sc_source.with(|object| object.sc_readable.as_ref().expect(\"scriptc: uninitialized Readable subclass\").clone()); runtime::readable_resume(&sc_readable); sc_readable_schedule(&sc_readable);";
    if (base === "%Duplex") return "let sc_duplex = sc_source.with(|object| object.sc_duplex.as_ref().expect(\"scriptc: uninitialized Duplex subclass\").clone()); sc_duplex_start_flowing(&sc_duplex);";
    if (base === "%Transform") return "let sc_transform = sc_source.with(|object| object.sc_transform.as_ref().expect(\"scriptc: uninitialized Transform subclass\").clone()); sc_transform_start_flowing(&sc_transform);";
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
    const base = this.context.runtimeStreamBase(className);
    if (base === "%Writable") return "let sc_writable = sc_destination.with(|object| object.sc_writable.as_ref().expect(\"scriptc: uninitialized Writable subclass\").clone()); runtime::writable_add_drain_resume(&sc_writable, sc_resume, sc_resume_trace);";
    if (base === "%Duplex") return "let sc_duplex = sc_destination.with(|object| object.sc_duplex.as_ref().expect(\"scriptc: uninitialized Duplex subclass\").clone()); runtime::writable_add_drain_resume(&runtime::duplex_writable(&sc_duplex), sc_resume, sc_resume_trace);";
    if (base === "%Transform") return "let sc_transform = sc_destination.with(|object| object.sc_transform.as_ref().expect(\"scriptc: uninitialized Transform subclass\").clone()); runtime::writable_add_drain_resume(&runtime::transform_writable(&sc_transform), sc_resume, sc_resume_trace);";
    this.context.unsupported(`pipe backpressure destination '${className}'`, loc);
  }

  private bind(args: readonly IrExpr[], values: readonly string[]): string {
    return args.map((arg, index) => `let ${values[index]} = ${this.context.emitExpr(arg)};`).join(" ");
  }

  private requiredValue(values: readonly string[], index: number, loc: SrcLoc): string {
    const value = values[index];
    if (value === undefined) this.context.unsupported("stream pipe argument arity", loc);
    return value;
  }

  private writableHandle(value: string, className: string, loc: SrcLoc): string {
    if (this.context.runtimeStreamBase(className) !== "%Writable") {
      this.context.unsupported("Writable subclass receiver", loc);
    }
    return `${value}.with(|object| object.sc_writable.as_ref().expect("scriptc: uninitialized Writable subclass").clone())`;
  }

  private duplexHandle(value: string, className: string, loc: SrcLoc): string {
    if (this.context.runtimeStreamBase(className) !== "%Duplex") {
      this.context.unsupported("Duplex subclass receiver", loc);
    }
    return `${value}.with(|object| object.sc_duplex.as_ref().expect("scriptc: uninitialized Duplex subclass").clone())`;
  }

  private transformHandle(value: string, className: string, loc: SrcLoc): string {
    if (this.context.runtimeStreamBase(className) !== "%Transform") {
      this.context.unsupported("Transform subclass receiver", loc);
    }
    return `${value}.with(|object| object.sc_transform.as_ref().expect("scriptc: uninitialized Transform subclass").clone())`;
  }
}
