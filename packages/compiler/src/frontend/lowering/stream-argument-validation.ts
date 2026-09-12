import { DYN, type IrExpr, STRING, VOID } from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import type * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isFreshObjectWithout } from "./literal-shapes.js";

const STREAM_CAPABILITIES: ReadonlySet<string> = new Set([
  "_readableState", "_writableState", "on", "pipe", "write",
  "getReader", "getWriter", "readable", "writable", "then",
]);

// Node's makeAsyncIterable ladder, shared by pipeline stage positions.
const PIPELINE_STAGE_EXPECTED =
  "of type function or an instance of Blob, ReadableStream, WritableStream, Stream, Iterable, AsyncIterable, or Promise or { readable, writable } pair";

/** Return a Node argument error only for a proven invalid input. Possible
 * streams and pipeline iterables retain the caller's unsupported fence. */
export function streamArgumentTypeError(
  L: Lowerer,
  node: ts.Expression,
  value: IrExpr,
  what: "finished" | "pipeline",
): IrExpr | null {
  if (!isJsSourceFile(node.getSourceFile()) ||
      (value.type.kind !== "dyn" && !L.dynConvertible(value.type))) return null;
  const plainLiteral = isFreshObjectWithout(value, STREAM_CAPABILITIES);
  const kind = value.type.kind;
  const invalid = what === "pipeline"
    ? plainLiteral || kind === "f64" || kind === "bool" || kind === "nullT"
    : plainLiteral || value.kind === "dynArrLit" ||
      kind === "string" || kind === "f64" || kind === "bool" || kind === "array" || kind === "nullT";
  if (!invalid) return null;
  const loc = locOf(node);
  return {
    kind: "libCall",
    fn: "error.argTypeThrow",
    args: [
      { kind: "strLit", value: what === "pipeline" ? "body" : "stream", type: STRING, loc },
      { kind: "strLit", value: what === "pipeline" ? PIPELINE_STAGE_EXPECTED
        : "an instance of ReadableStream, WritableStream, or Stream", type: STRING, loc },
      value.type.kind === "dyn" ? value : { kind: "dynFrom", value, type: DYN, loc },
    ],
    type: VOID,
    loc,
  };
}
