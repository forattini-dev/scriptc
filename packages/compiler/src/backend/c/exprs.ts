import type { LibCallState } from "./lib-call-context.js";
import { emitNetworkLibCall, emitHttpLibCall } from "./lib-network.js";
import { emitNumericCoercion, isNumericCoercionFn } from "./emit-numeric-coercion.js";
import { regexCaptureLayout } from "../../ir/regex-captures.js";
import { dynPromiseAdapter } from "./emit-dynamic-promise.js";
import { emitReadlineNextLine } from "./emit-readline.js";
import { InternalCompilerError } from "../../errors.js";
/* Expression C emission: the whole IrExpr dispatch (emitExpr) — every IR
 * expression lands in a fresh C temp, with RC ownership tracked on the
 * emitter's frames (see the discipline comment in emitter core). */
import type { CEmitter, Temp } from "./c-emitter.js";
            const w = emitter.newTemp(F64, `scr_process_${e.fn === "process.rows" ? "rows" : "columns"}(${arg(0)})`);
