import type { IrType } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import type { IrFuncType, RustClosureShape } from "./model.js";

type StreamNode = Record<string, unknown>;
type StreamArgument = { kind?: string; type?: IrType; value?: unknown };

/** Closure-shape discovery and usage state shared by the Rust stream emitters. */
export class RustStreamModel {
  usesReadable = false;
  usesWritable = false;
  usesDuplex = false;
  usesTransform = false;
  readonly readableReadShapes = new Map<string, RustClosureShape>();
  readonly writableWriteShapes = new Map<string, RustClosureShape>();
  readonly writableFinalShapes = new Map<string, RustClosureShape>();
  readonly writableDoneShapes = new Map<string, RustClosureShape>();
  readonly duplexReadShapes = new Map<string, RustClosureShape>();
  readonly duplexWriteShapes = new Map<string, RustClosureShape>();
  readonly duplexFinalShapes = new Map<string, RustClosureShape>();
  readonly duplexDoneShapes = new Map<string, RustClosureShape>();
  readonly transformCallbackShapes = new Map<string, RustClosureShape>();
  readonly transformFlushShapes = new Map<string, RustClosureShape>();
  readonly transformDoneShapes = new Map<string, RustClosureShape>();

  discover(
    node: StreamNode,
    ensureClosureShape: (type: IrFuncType) => RustClosureShape,
    unsupported: (kind: string) => never,
  ): boolean {
    if (node.kind !== "libCall") return false;
    if (node.fn === "readable.new") {
      this.usesReadable = true;
      const args = node.args as StreamArgument[] | undefined;
      const flags = args?.[3];
      if (flags?.kind !== "numLit" || typeof flags.value !== "number") {
        unsupported("malformed Readable callback flags IR");
      }
      if ((flags.value & 1) === 0) return true;
      const callback = args?.[4];
      if (callback?.type?.kind !== "func") unsupported("malformed Readable callback IR");
      const shape = ensureClosureShape(callback.type);
      this.readableReadShapes.set(typeKey(callback.type), shape);
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
      if (bit <= 1) this.markRuntimeCompletion(callback.type, ensureClosureShape, unsupported);
    }
    return true;
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
