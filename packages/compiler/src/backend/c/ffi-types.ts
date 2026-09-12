import { InternalCompilerError } from "../../errors.js";
import type { IrFfiCallbackParamClass, IrFfiCallbackParam, IrFfiReleaseParam, IrFfiReturnClass, IrFfiValueParamClass } from "../../ir/ir.js";
import { isFfiContextParam } from "../../ir/ir.js";

export function ffiNativeTypeC(
  cls: IrFfiCallbackParamClass | IrFfiValueParamClass | IrFfiReturnClass,
): string {
  switch (cls) {
    case "f64":
      return "double";
    case "bool":
    case "u8":
      return "uint8_t";
    case "u32":
      return "uint32_t";
    case "i32":
      return "int32_t";
    case "cstring":
      return "const char *";
    case "string":
    case "bytes":
      throw new InternalCompilerError(`emitter bug: span class '${cls}' has no scalar C type`);
    case "void":
      return "void";
  }
}

export function ffiCallbackNativeParamsC(
  callback: IrFfiCallbackParam["callback"] | IrFfiReleaseParam["callback"],
  named: boolean,
): string[] {
  return callback.params.flatMap((param, i): string[] => {
    if (isFfiContextParam(param)) return [`void *${named ? "sc_ctx" : ""}`.trim()];
    if (param === "string" || param === "bytes") {
      return [
        `const uint8_t *${named ? `sc_a${i}` : ""}`.trim(),
        `size_t${named ? ` sc_a${i}_len` : ""}`,
      ];
    }
    return [`${ffiNativeTypeC(param)}${named ? ` sc_a${i}` : ""}`];
  });
}

export function ffiCallbackPointerTypeC(
  callback: IrFfiCallbackParam["callback"] | IrFfiReleaseParam["callback"],
): string {
  const ret = ffiNativeTypeC(callback.returns);
  const params = ffiCallbackNativeParamsC(callback, false);
  return `${ret} (*)(${params.length > 0 ? params.join(", ") : "void"})`;
}

export function ffiCallbackDummyC(callback: IrFfiCallbackParam["callback"]): string {
  return callback.returns === "void" ? "" : "0";
}
