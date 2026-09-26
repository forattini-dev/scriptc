/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { matchStringSelfConcat, undefinedArmTag } from "../../ir/analysis.js";
import { isRefCounted, type IrBytesElem } from "../../ir/ir.js";
import { mangleRecordClone, mangleRecordNew } from "../mangle.js";
import { arrNewCall, elemAccess } from "./shapes.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, ExprOf, LlValue } from "./expr-context.js";

          const value = host.emitToUint32(v.name, e.operand);
          const result = B.tmp();
          B.line(`${result} = xor i32 ${value}, -1`);
          B.line(`${t} = sitofp i32 ${result} to double`);
