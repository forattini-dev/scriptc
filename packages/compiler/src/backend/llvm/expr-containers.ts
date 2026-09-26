/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
        return args[1]
          ? call("scr_str_ends_with_from", "zeroext i1 (ptr, ptr, double)", `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1].name}`, "i1", false)
          : call("scr_str_ends_with", "zeroext i1 (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, "i1", false);
