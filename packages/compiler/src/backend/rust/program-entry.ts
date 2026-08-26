import { mangleFnClosure, mangleFunction, mangleGlobal } from "../mangle.js";

export interface RustProgramEntryOptions {
  readonly entryName: string;
  readonly entryAsync: boolean;
  readonly hasErrorClasses: boolean;
  readonly heapGlobalIds: readonly string[];
  readonly internedClosureNames: readonly string[];
  readonly usesDyn: boolean;
  readonly usesDynamicInvoke: boolean;
  readonly usesProcessExitListeners: boolean;
}

/** Emit the process boundary separately from IR expression/statement emission. */
export function emitRustProgramEntry(options: RustProgramEntryOptions): string[] {
  const lines = [
    "fn main() {",
    "    runtime::init();",
    "    let _sc_execution = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {",
    options.entryAsync
      ? `        let _sc_main_promise = ${mangleFunction(options.entryName)}();`
      : `        ${mangleFunction(options.entryName)}();`,
    "        runtime::run_event_loop();",
    "        let _sc_unhandled_rejection = runtime::had_unhandled_rejection();",
  ];
  if (options.entryAsync) lines.push("        drop(_sc_main_promise);");
  lines.push(
    "        _sc_unhandled_rejection",
    "    }));",
    "    let (_sc_unhandled_rejection, _sc_uncaught) = match _sc_execution {",
    "        Ok(unhandled) => (unhandled, None),",
    "        Err(payload) => {",
    "            let caught = runtime::caught_from_panic(payload);",
    `            let message = ${options.hasErrorClasses ? "sc_caught_to_string" : "runtime::caught_to_string"}(&caught);`,
    "            drop(caught);",
    "            (false, Some(message))",
    "        },",
    "    };",
  );
  if (options.usesProcessExitListeners) {
    lines.push("    sc_process_run_exit(if _sc_uncaught.is_some() || _sc_unhandled_rejection { 1.0 } else { 0.0 });");
  }
  for (const id of options.heapGlobalIds) {
    lines.push(`    ${mangleGlobal(id)}.with(|slot| *slot.borrow_mut() = None);`);
  }
  for (const name of options.internedClosureNames) {
    lines.push(`    ${mangleFnClosure(name)}.with(|slot| *slot.borrow_mut() = None);`);
  }
  if (options.usesDyn) lines.push("    sc_dyn_error_cache_clear();");
  if (options.usesDynamicInvoke) lines.push("    sc_dyn_function_cache_clear();");
  lines.push(
    "    runtime::finish();",
    "    if let Some(reason) = _sc_uncaught { eprintln!(\"Uncaught {}\", reason); std::process::exit(1); }",
    "    if _sc_unhandled_rejection { std::process::exit(1); }",
    "}",
  );
  return lines;
}
