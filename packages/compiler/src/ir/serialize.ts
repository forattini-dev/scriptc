import { InternalCompilerError } from "../errors.js";
/* IR ↔ JSON. The IR is plain JSON-safe data except for the complete f64
 * literal domain. JavaScript globals can produce NaN and ±Infinity, and -0
 * has an observable sign, so those values use an explicit sentinel instead
 * of JSON.stringify's lossy null/zero encodings.
 */
import type { IrModule } from "./ir.js";

export const IR_VERSION = 12 as const;

export function serializeModule(mod: IrModule): string {
  return JSON.stringify(mod, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      // The sentinel object cannot collide with a number-valued IR field.
      return { $nonfinite: Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf" };
    }
    // JSON.stringify(-0) prints "0", silently losing the sign a numLit's
    // f64 semantics depend on (String(-0) is "0" but 1/-0 is -Infinity) —
    // the same sentinel mechanism carries it.
    if (typeof value === "number" && Object.is(value, -0)) {
      return { $nonfinite: "-0" };
    }
    return value;
  }, 2);
}

export function deserializeModule(json: string): IrModule {
  const mod = JSON.parse(json, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && "$nonfinite" in value) {
      const tag = (value as { $nonfinite: string }).$nonfinite;
      if (tag === "nan") return NaN;
      if (tag === "inf") return Infinity;
      if (tag === "-inf") return -Infinity;
      if (tag === "-0") return -0;
      throw new InternalCompilerError(`unknown non-finite IR number tag '${tag}'`);
    }
    return value;
  }) as IrModule;
  if (mod.irVersion !== IR_VERSION) {
    throw new Error(
      `IR version mismatch: file has ${String(mod.irVersion)}, compiler expects ${IR_VERSION}`,
    );
  }
  return mod;
}
