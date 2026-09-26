import { InternalCompilerError } from "../../errors.js";
import type { IrFfiCallbackParamClass, IrFfiReturnClass, IrFfiValueParamClass } from "../../ir/ir.js";

/** User-controlled text embedded after an LLVM `;` comment marker. Preserve
 * ordinary output byte-for-byte, but encode control and line-separator code
 * units so a property name can never inject a line or invalid source byte. */
export function llvmCommentText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

export function ffiNativeTypeLl(
  cls: IrFfiCallbackParamClass | IrFfiValueParamClass | IrFfiReturnClass,
): string {
  switch (cls) {
    case "f64":
      return "double";
    case "bool":
    case "u8":
      return "i8";
    case "u32":
    case "i32":
      return "i32";
    case "cstring":
      return "ptr";
    case "string":
    case "bytes":
      throw new InternalCompilerError(`llvm emitter bug: span class '${cls}' has no scalar LLVM type`);
    case "void":
      return "void";
  }
}

export function f64Lit(n: number): string {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n);
  return `0x${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export const F64_INF = f64Lit(Infinity);

export const F64_NAN = f64Lit(NaN);
