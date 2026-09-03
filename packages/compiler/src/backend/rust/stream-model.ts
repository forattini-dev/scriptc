import type { IrType } from "../../ir/nodes.js";
import { DYN, typeKey, VOID } from "../../ir/nodes.js";
import type { IrFuncType, RustClosureShape } from "./model.js";

type StreamNode = Record<string, unknown>;
type StreamArgument = { kind?: string; type?: IrType; value?: unknown };

/** Closure-shape discovery and usage state shared by the Rust stream emitters. */
export class RustStreamModel {
  usesReadable = false;
  usesReadableSubclass = false;
  usesWritable = false;
  usesWritableSubclass = false;
  usesDuplex = false;
  usesDuplexSubclass = false;
  usesTransform = false;
  usesTransformSubclass = false;
  usesReadableDestroy = false;
  usesWritableDestroy = false;
  usesStreamFinished = false;
  usesStreamPipeline = false;
  usesStreamConsumers = false;
  readonly readableReadShapes = new Map<string, RustClosureShape>();
  readonly readableDestroyShapes = new Map<string, RustClosureShape>();
  readonly writableWriteShapes = new Map<string, RustClosureShape>();
  readonly writableFinalShapes = new Map<string, RustClosureShape>();
  readonly writableDoneShapes = new Map<string, RustClosureShape>();
  writableDynamicCompletionShape: RustClosureShape | null = null;
  readonly duplexReadShapes = new Map<string, RustClosureShape>();
  readonly duplexWriteShapes = new Map<string, RustClosureShape>();
  readonly duplexFinalShapes = new Map<string, RustClosureShape>();
  readonly duplexDoneShapes = new Map<string, RustClosureShape>();
  duplexDynamicCompletionShape: RustClosureShape | null = null;
  readonly transformCallbackShapes = new Map<string, RustClosureShape>();
  readonly transformFlushShapes = new Map<string, RustClosureShape>();
  readonly transformDoneShapes = new Map<string, RustClosureShape>();
  transformDynamicCompletionShape: RustClosureShape | null = null;

  discover(
    node: StreamNode,
    ensureClosureShape: (type: IrFuncType) => RustClosureShape,
    unsupported: (kind: string) => never,
    registerDynBoxedFunction: (type: IrFuncType) => void,
  ): boolean {
    if (node.kind !== "libCall") return false;
    if (node.fn === "sp.finished" || node.fn === "stream.finished" || node.fn === "stream.finishedDyn") {
      this.usesStreamFinished = true;
      const args = node.args as StreamArgument[] | undefined;
      this.markStreamType(args?.[0]?.type, false);
      if (node.fn === "stream.finished") {
        const callback = args?.[1]?.type;
        if (callback?.kind !== "func") unsupported("malformed stream.finished callback IR");
        ensureClosureShape(callback);
      }
      if (node.fn !== "sp.finished") {
        const cleanup = node.type as IrType | undefined;
        if (cleanup?.kind !== "func") unsupported("malformed stream.finished cleanup IR");
        ensureClosureShape(cleanup).runtimeCallback = true;
      }
      return true;
    }
    if (node.fn === "sp.pipeline" || node.fn === "stream.pipeline" || node.fn === "stream.pipelineDyn") {
      this.usesStreamFinished = true;
      this.usesStreamPipeline = true;
      const args = node.args as StreamArgument[] | undefined;
      const pipelineArgs = args?.slice(1) ?? [];
      const streams = node.fn === "sp.pipeline" ? pipelineArgs : pipelineArgs.slice(0, -1);
      for (const arg of streams) {
        this.markStreamType(arg.type, true);
      }
      if (node.fn === "stream.pipeline") {
        const callback = pipelineArgs.at(-1)?.type;
        if (callback?.kind !== "func") unsupported("malformed stream.pipeline callback IR");
        ensureClosureShape(callback);
      }
      return true;
    }
    if (node.fn === "sc.text" || node.fn === "sc.json" || node.fn === "sc.buffer") {
      this.usesStreamFinished = true;
      this.usesStreamConsumers = true;
      this.markStreamType((node.args as StreamArgument[] | undefined)?.[0]?.type, false);
      return true;
    }
    if (node.fn === "stream.destroy" || node.fn === "stream.destroyErr") {
      const receiver = (node.args as StreamArgument[] | undefined)?.[0]?.type;
      if (receiver?.kind === "object" && receiver.className === "%Readable") {
        this.usesReadable = true;
        this.usesReadableDestroy = true;
        return true;
      }
      if (receiver?.kind === "object" && receiver.className === "%Writable") {
        this.usesWritable = true;
        this.usesWritableDestroy = true;
        return true;
      }
    }
    if (node.fn === "stream.setRead" || node.fn === "stream.setWrite" ||
        node.fn === "stream.setFinal" || node.fn === "stream.setDestroy" ||
        node.fn === "stream.setTransform" || node.fn === "stream.setFlush") {
      const args = node.args as StreamArgument[] | undefined;
      const receiver = args?.[0]?.type;
      const callback = args?.[1]?.type;
      if (receiver?.kind !== "object" || callback?.kind !== "func") {
        unsupported(`malformed ${String(node.fn)} callback IR`);
      }
      if (node.fn === "stream.setRead" && receiver.className === "%Readable") {
        this.usesReadable = true;
        this.readableReadShapes.set(typeKey(callback), ensureClosureShape(callback));
        return true;
      }
      if (node.fn === "stream.setDestroy" && receiver.className === "%Readable") {
        this.usesReadable = true;
        this.usesReadableDestroy = true;
        this.readableDestroyShapes.set(typeKey(callback), ensureClosureShape(callback));
        this.markRuntimeCompletion(callback, ensureClosureShape, unsupported);
        return true;
      }
      if ((node.fn === "stream.setWrite" || node.fn === "stream.setFinal") &&
          receiver.className === "%Writable") {
        this.usesWritable = true;
        const completion = callback.params.at(-1);
        const shape = ensureClosureShape(callback);
        (node.fn === "stream.setWrite" ? this.writableWriteShapes : this.writableFinalShapes)
          .set(typeKey(callback), shape);
        if (completion?.kind === "func") {
          this.markRuntimeCompletion(callback, ensureClosureShape, unsupported);
        } else if (completion?.kind === "dyn" && callback.params.every((param) => param.kind === "dyn")) {
          const completionType: IrFuncType = { kind: "func", params: [], ret: VOID };
          registerDynBoxedFunction(completionType);
          const completionShape = ensureClosureShape(completionType);
          completionShape.runtimeCallback = true;
          this.writableDynamicCompletionShape = completionShape;
        }
        return true;
      }
      if (node.fn === "stream.setDestroy" && receiver.className === "%Writable") {
        this.usesWritable = true;
        this.usesWritableDestroy = true;
        ensureClosureShape(callback);
        this.markRuntimeCompletion(callback, ensureClosureShape, unsupported);
        return true;
      }
      if ((node.fn === "stream.setTransform" || node.fn === "stream.setFlush") &&
          (receiver.className === "%Transform" || receiver.className === "%PassThrough")) {
        this.usesTransform = true;
        const shape = ensureClosureShape(callback);
        (node.fn === "stream.setTransform" ? this.transformCallbackShapes : this.transformFlushShapes)
          .set(typeKey(callback), shape);
        this.markRuntimeCompletion(callback, ensureClosureShape, unsupported);
        return true;
      }
    }
    if (node.fn === "readable.new") {
      this.usesReadable = true;
      const args = node.args as StreamArgument[] | undefined;
      const flags = args?.[3];
      if (flags?.kind !== "numLit" || typeof flags.value !== "number") {
        unsupported("malformed Readable callback flags IR");
      }
      let callbackIndex = 4;
      for (let bit = 0; bit < 2; bit += 1) {
        if ((flags.value & (1 << bit)) === 0) continue;
        const callback = args?.[callbackIndex++];
        if (callback?.type?.kind !== "func") unsupported("malformed Readable callback IR");
        const shape = ensureClosureShape(callback.type);
        if (bit === 0) this.readableReadShapes.set(typeKey(callback.type), shape);
        if (bit === 1) {
          this.readableDestroyShapes.set(typeKey(callback.type), shape);
          this.markRuntimeCompletion(callback.type, ensureClosureShape, unsupported);
        }
      }
      return true;
    }
    if (node.fn === "readable.newDyn") {
      this.usesReadable = true;
      // Dynamic option callbacks use the same type-erased runtime bridge as
      // subclass callbacks, even though the returned object is the base type.
      this.usesReadableSubclass = true;
      return true;
    }
    if (node.fn === "readable.init" || node.fn === "readable.initDyn") {
      this.usesReadable = true;
      this.usesReadableSubclass = true;
      const args = node.args as StreamArgument[] | undefined;
      const dynamic = node.fn === "readable.initDyn";
      const flags = args?.[dynamic ? 2 : 4];
      if (flags?.kind !== "numLit" || typeof flags.value !== "number") {
        unsupported("malformed Readable subclass callback flags IR");
      }
      let callbackIndex = dynamic ? 3 : 5;
      for (let bit = 0; bit < 2; bit += 1) {
        if ((flags.value & (1 << bit)) === 0) continue;
        const callback = args?.[callbackIndex++];
        if (callback?.type?.kind !== "func") unsupported("malformed Readable subclass callback IR");
        const shape = ensureClosureShape(callback.type);
        if (bit === 0) this.readableReadShapes.set(typeKey(callback.type), shape);
        if (bit === 1) {
          this.readableDestroyShapes.set(typeKey(callback.type), shape);
          this.markRuntimeCompletion(callback.type, ensureClosureShape, unsupported);
        }
      }
      return true;
    }
    if (node.fn === "writable.init" || node.fn === "writable.initDyn") {
      this.usesWritable = true;
      this.usesWritableSubclass = true;
      const args = node.args as StreamArgument[] | undefined;
      const dynamic = node.fn === "writable.initDyn";
      const flags = args?.[dynamic ? 2 : 4];
      if (flags?.kind !== "numLit" || typeof flags.value !== "number") {
        unsupported("malformed Writable subclass callback flags IR");
      }
      let callbackIndex = dynamic ? 3 : 5;
      for (let bit = 0; bit < 3; bit += 1) {
        if ((flags.value & (1 << bit)) === 0) continue;
        const callback = args?.[callbackIndex++];
        if (callback?.type?.kind !== "func") unsupported("malformed Writable subclass callback IR");
        ensureClosureShape(callback.type);
        const completion = callback.type.params.at(-1);
        if (dynamic && bit === 0 && completion?.kind === "dyn") {
          const completionType: IrFuncType = { kind: "func", params: [], ret: VOID };
          registerDynBoxedFunction(completionType);
          const completionShape = ensureClosureShape(completionType);
          completionShape.runtimeCallback = true;
          this.writableDynamicCompletionShape = completionShape;
        } else {
          this.markRuntimeCompletion(callback.type, ensureClosureShape, unsupported);
        }
        if (bit === 2) this.usesWritableDestroy = true;
      }
      return true;
    }
    if (node.fn === "writable.newDyn") {
      this.usesWritable = true;
      this.usesWritableSubclass = true;
      const completionType: IrFuncType = { kind: "func", params: [], ret: VOID };
      registerDynBoxedFunction(completionType);
      const completionShape = ensureClosureShape(completionType);
      completionShape.runtimeCallback = true;
      this.writableDynamicCompletionShape = completionShape;
      return true;
    }
    if (node.fn === "duplex.init" || node.fn === "transform.init" || node.fn === "passthrough.init") {
      const transform = node.fn !== "duplex.init";
      if (transform) {
        this.usesTransform = true;
        this.usesTransformSubclass = true;
      } else {
        this.usesDuplex = true;
        this.usesDuplexSubclass = true;
      }
      const args = node.args as StreamArgument[] | undefined;
      const flags = args?.[8];
      if (flags?.kind !== "numLit" || typeof flags.value !== "number") {
        unsupported(`malformed ${transform ? "Transform" : "Duplex"} subclass callback flags IR`);
      }
      let callbackIndex = 9;
      const callbackBits = transform ? 2 : 4;
      for (let bit = 0; bit < callbackBits; bit += 1) {
        if ((flags.value & (1 << bit)) === 0) continue;
        const callback = args?.[callbackIndex++];
        if (callback?.type?.kind !== "func") unsupported("malformed stream subclass callback IR");
        ensureClosureShape(callback.type);
        if (transform && bit === 0 && callback.type.params.at(-1)?.kind === "dyn") {
          const completionType: IrFuncType = { kind: "func", params: [DYN, DYN], ret: VOID };
          registerDynBoxedFunction(completionType);
          const completionShape = ensureClosureShape(completionType);
          completionShape.runtimeCallback = true;
          this.transformDynamicCompletionShape = completionShape;
        } else if ((transform && bit <= 1) || (!transform && (bit === 1 || bit === 2))) {
          this.markRuntimeCompletion(callback.type, ensureClosureShape, unsupported);
        }
      }
      return true;
    }
    if (node.fn === "duplex.newDyn") {
      this.usesDuplex = true;
      this.usesDuplexSubclass = true;
      const completionType: IrFuncType = { kind: "func", params: [], ret: VOID };
      registerDynBoxedFunction(completionType);
      const completionShape = ensureClosureShape(completionType);
      completionShape.runtimeCallback = true;
      this.duplexDynamicCompletionShape = completionShape;
      return true;
    }
    if (node.fn === "readable.fromArr" || node.fn === "readable.nextChunk" ||
        node.fn === "readable.nextChunkDyn") {
      this.usesReadable = true;
      return true;
    }
    if (node.fn === "writable.write" || node.fn === "writable.writeStr") {
      const args = node.args as StreamArgument[] | undefined;
      const receiver = args?.[0]?.type;
      const duplex = receiver?.kind === "object" && receiver.className === "%Duplex";
      const transform = receiver?.kind === "object" &&
        (receiver.className === "%Transform" || receiver.className === "%PassThrough");
      if (duplex) this.usesDuplex = true;
      else if (transform) this.usesTransform = true;
      else this.usesWritable = true;
      const callback = args?.[2];
      if (callback === undefined) return true;
      if (callback.type?.kind !== "func") unsupported("malformed Writable write completion IR");
      const shape = ensureClosureShape(callback.type);
      (duplex ? this.duplexDoneShapes : transform ? this.transformDoneShapes : this.writableDoneShapes)
        .set(typeKey(callback.type), shape);
      return true;
    }
    if (node.fn === "transform.new" || node.fn === "passthrough.new") {
      this.usesTransform = true;
      const args = node.args as StreamArgument[] | undefined;
      const flags = args?.[7];
      if (flags?.kind !== "numLit" || typeof flags.value !== "number") {
        unsupported("malformed Transform callback flags IR");
      }
      let callbackIndex = 8;
      for (let bit = 0; bit < 3; bit += 1) {
        if ((flags.value & (1 << bit)) === 0) continue;
        const callback = args?.[callbackIndex++];
        if (callback?.type?.kind !== "func") unsupported("malformed Transform callback IR");
        const shape = ensureClosureShape(callback.type);
        if (bit === 0) this.transformCallbackShapes.set(typeKey(callback.type), shape);
        if (bit === 1) this.transformFlushShapes.set(typeKey(callback.type), shape);
        if (bit <= 1) this.markRuntimeCompletion(callback.type, ensureClosureShape, unsupported);
      }
      return true;
    }
    if (node.fn === "duplex.new") {
      this.usesDuplex = true;
      const args = node.args as StreamArgument[] | undefined;
      const flags = args?.[7];
      if (flags?.kind !== "numLit" || typeof flags.value !== "number") {
        unsupported("malformed Duplex callback flags IR");
      }
      let callbackIndex = 8;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((flags.value & (1 << bit)) === 0) continue;
        const callback = args?.[callbackIndex++];
        if (callback?.type?.kind !== "func") unsupported("malformed Duplex callback IR");
        const shape = ensureClosureShape(callback.type);
        if (bit === 0) this.duplexReadShapes.set(typeKey(callback.type), shape);
        if (bit === 1) this.duplexWriteShapes.set(typeKey(callback.type), shape);
        if (bit === 2) this.duplexFinalShapes.set(typeKey(callback.type), shape);
        if (bit === 1 || bit === 2) this.markRuntimeCompletion(callback.type, ensureClosureShape, unsupported);
      }
      return true;
    }
    if (node.fn !== "writable.new") return false;
    this.usesWritable = true;
    const args = node.args as StreamArgument[] | undefined;
    const flags = args?.[3];
    if (flags?.kind !== "numLit" || typeof flags.value !== "number") {
      unsupported("malformed Writable callback flags IR");
    }
    let callbackIndex = 4;
    for (let bit = 0; bit < 3; bit += 1) {
      if ((flags.value & (1 << bit)) === 0) continue;
      const callback = args?.[callbackIndex++];
      if (callback?.type?.kind !== "func") unsupported("malformed Writable callback IR");
      const shape = ensureClosureShape(callback.type);
      if (bit === 0) this.writableWriteShapes.set(typeKey(callback.type), shape);
      if (bit === 1) this.writableFinalShapes.set(typeKey(callback.type), shape);
      const completion = callback.type.params.at(-1);
      if (bit === 0 && completion?.kind === "dyn" &&
          callback.type.params.every((param) => param.kind === "dyn")) {
        const completionType: IrFuncType = { kind: "func", params: [], ret: VOID };
        registerDynBoxedFunction(completionType);
        const completionShape = ensureClosureShape(completionType);
        completionShape.runtimeCallback = true;
        this.writableDynamicCompletionShape = completionShape;
      } else if (bit <= 1) {
        this.markRuntimeCompletion(callback.type, ensureClosureShape, unsupported);
      }
    }
    return true;
  }

  private markStreamType(type: IrType | undefined, pipeline: boolean): void {
    if (type?.kind !== "object") return;
    if (type.className === "%Readable") {
      this.usesReadable = true;
      if (pipeline) this.usesReadableDestroy = true;
    } else if (type.className === "%Writable") {
      this.usesWritable = true;
      if (pipeline) this.usesWritableDestroy = true;
    } else if (type.className === "%Duplex") {
      this.usesDuplex = true;
    } else if (type.className === "%Transform" || type.className === "%PassThrough") {
      this.usesTransform = true;
    }
  }

  private markRuntimeCompletion(
    callback: IrFuncType,
    ensureClosureShape: (type: IrFuncType) => RustClosureShape,
    unsupported: (kind: string) => never,
  ): void {
    const completion = callback.params.at(-1);
    if (completion?.kind !== "func") unsupported("malformed Writable completion callback IR");
    ensureClosureShape(completion).runtimeCallback = true;
  }
}
