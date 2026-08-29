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
  readonly usesProcessRejectionEvents: boolean;
  readonly usesProcessWarningEvents: boolean;
  readonly usesEmbeddedModules: boolean;
}

/** Emit the process boundary separately from IR expression/statement emission. */
export function emitRustProgramEntry(options: RustProgramEntryOptions): string[] {
  const lines = [
    "fn main() {",
    "    runtime::init();",
    ...(options.usesEmbeddedModules
      ? ["    runtime::island_register_modules(&SC_ISLAND_MODULES);"]
      : []),
    "    let _sc_execution = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {",
    options.entryAsync
      ? `        let _sc_main_promise = ${mangleFunction(options.entryName)}(); runtime::promise_track_entry(&_sc_main_promise);`
      : `        ${mangleFunction(options.entryName)}();`,
    "        runtime::run_event_loop();",
    "        let _sc_unhandled_rejection = runtime::had_unhandled_rejection();",
  ];
  if (options.entryAsync) {
    lines.push(
      "        let _sc_main_outcome = runtime::promise_take_entry_outcome();",
      "        drop(_sc_main_promise);",
      "        let _sc_unsettled_tla = _sc_main_outcome.is_none();",
      "        (_sc_unhandled_rejection, _sc_main_outcome.and_then(Result::err), _sc_unsettled_tla)",
    );
  } else {
    lines.push("        (_sc_unhandled_rejection, None, false)");
  }
  lines.push(
    "    }));",
    "    let (_sc_unhandled_rejection, _sc_uncaught, _sc_unsettled_tla) = match _sc_execution {",
    "        Ok((unhandled, async_error, unsettled)) => {",
    `            let message = async_error.map(|caught| { let message = ${options.hasErrorClasses ? "sc_caught_to_string" : "runtime::caught_to_string"}(&caught); drop(caught); message });`,
    "            (unhandled, message, unsettled)",
    "        },",
    "        Err(payload) => {",
    "            let caught = runtime::caught_from_panic(payload);",
    `            let message = ${options.hasErrorClasses ? "sc_caught_to_string" : "runtime::caught_to_string"}(&caught);`,
    "            drop(caught);",
    "            (false, Some(message), false)",
    "        },",
    "    };",
  );
  if (options.usesProcessExitListeners) {
    lines.push("    sc_process_run_exit(if _sc_unsettled_tla { 13.0 } else if _sc_uncaught.is_some() || _sc_unhandled_rejection { 1.0 } else { f64::from(runtime::process_exit_code()) });");
  }
  for (const id of options.heapGlobalIds) {
    lines.push(`    ${mangleGlobal(id)}.with(|slot| *slot.borrow_mut() = None);`);
  }
  for (const name of options.internedClosureNames) {
    lines.push(`    ${mangleFnClosure(name)}.with(|slot| *slot.borrow_mut() = None);`);
  }
  if (options.usesDyn) lines.push("    sc_dyn_error_cache_clear();");
  if (options.usesDynamicInvoke) lines.push("    sc_dyn_function_cache_clear();");
  if (options.usesProcessRejectionEvents) lines.push("    sc_process_rejection_clear();");
  if (options.usesProcessWarningEvents) lines.push("    sc_process_warning_clear();");
  lines.push(
    "    runtime::finish();",
    "    if let Some(reason) = _sc_uncaught { eprintln!(\"Uncaught {}\", reason); std::process::exit(1); }",
    "    if _sc_unhandled_rejection { std::process::exit(1); }",
    "    if _sc_unsettled_tla { std::process::exit(13); }",
    "    let _sc_exit_code = runtime::process_exit_code();",
    "    if _sc_exit_code != 0 { std::process::exit(_sc_exit_code); }",
    "}",
  );
  return lines;
}
