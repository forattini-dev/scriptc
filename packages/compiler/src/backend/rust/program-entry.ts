import type { IrModule } from "../../ir/nodes.js";
import { mangleFnClosure, mangleFunction, mangleGlobal } from "../mangle.js";

export interface RustProgramEntryOptions {
  readonly entryName: string;
  readonly entryAsync: boolean;
  readonly entryCommonJs: boolean;
  readonly hasErrorClasses: boolean;
  readonly heapGlobalIds: readonly string[];
  readonly internedClosureNames: readonly string[];
  readonly usesDyn: boolean;
  readonly usesDynamicInvoke: boolean;
  readonly usesProcessExitListeners: boolean;
  readonly usesProcessRejectionEvents: boolean;
  /** process.on("uncaughtException") listeners: a synchronous throw or the
   * entry's rejection dispatches to them and the loop runs on. */
  readonly usesProcessUncaughtListeners: boolean;
  readonly usesProcessWarningEvents: boolean;
  readonly usesEmbeddedModules: boolean;
  readonly runtimeTarget?: NonNullable<IrModule["runtimeTarget"]>;
}

/** The runtime's per-target configuration call — the one place the
 * binary learns which runtime it reproduces. Absent target = the matrix
 * primary, which is also the runtime's built-in default. */
function targetConfigureLine(target: RustProgramEntryOptions["runtimeTarget"]): string[] {
  if (target === undefined) return [];
  const rule = target.readableBareRead === "head-chunk" ? "HeadChunk" : "CollapseQueue";
  return [
    `    runtime::target_configure(runtime::TargetConfig { runtime_id: ${JSON.stringify(target.id)}, node_version: ${JSON.stringify(target.semanticsNode)}, readable_bare_read: runtime::ReadRule::${rule} });`,
  ];
}

/** Emit the process boundary separately from IR expression/statement emission. */
export function emitRustProgramEntry(options: RustProgramEntryOptions): string[] {
  const lines = [
    // The program runs on a thread with a generous stack: the island's
    // parser is recursive-descent and overflows the 8 MB main-thread
    // stack on generated validators (ajv-style nested conditionals);
    // deep static recursion gets the same headroom. Everything — runtime
    // init, the entry, the event loop, teardown — runs on that one thread
    // (the runtime is thread-confined), and exits propagate as they did.
    "fn main() {",
    "    let sc_program = std::thread::Builder::new()",
    "        .name(\"scriptc-program\".to_owned())",
    "        .stack_size(256 * 1024 * 1024)",
    "        .spawn(sc_program_main)",
    "        .expect(\"scriptc: could not start the program thread\");",
    "    if sc_program.join().is_err() { std::process::exit(101); }",
    "}",
    "fn sc_program_main() {",
    "    runtime::init();",
    ...targetConfigureLine(options.runtimeTarget),
    ...(options.usesEmbeddedModules
      ? [
        "    runtime::island_register_modules(&SC_ISLAND_MODULES);",
        "    runtime::island_register_edges(&SC_ISLAND_EDGES);",
        "    runtime::island_register_build_id(SC_ISLAND_BUILD_ID);",
      ]
      : []),
    "    let _sc_execution = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {",
    options.entryAsync
      ? `        let _sc_main_promise = ${mangleFunction(options.entryName)}(); runtime::promise_track_entry(&_sc_main_promise);`
      : `        ${mangleFunction(options.entryName)}();`,
    options.entryCommonJs
      ? "        runtime::run_event_loop_commonjs();"
      : "        runtime::run_event_loop();",
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
    ...(options.usesProcessUncaughtListeners
      ? ["            let async_error = async_error.and_then(|caught: runtime::Caught| if sc_process_uncaught_dispatch_caught(caught.clone()) { drop(caught); runtime::run_event_loop(); None } else { Some(caught) });"]
      : []),
    `            let message = async_error.map(|caught| { let message = ${options.hasErrorClasses ? "sc_caught_to_string" : "runtime::caught_to_string"}(&caught); drop(caught); message });`,
    "            (unhandled, message, unsettled)",
    "        },",
    "        Err(payload) => {",
    "            let caught = runtime::caught_from_panic(payload);",
    ...(options.usesProcessUncaughtListeners
      ? [
        "            if sc_process_uncaught_dispatch_caught(caught.clone()) { drop(caught); let _sc_after = std::panic::catch_unwind(std::panic::AssertUnwindSafe(runtime::run_event_loop)); (runtime::had_unhandled_rejection(), _sc_after.err().map(|payload| { let caught = runtime::caught_from_panic(payload); let message = " + (options.hasErrorClasses ? "sc_caught_to_string" : "runtime::caught_to_string") + "(&caught); drop(caught); message }), false) } else {",
      ]
      : []),
    `            let message = ${options.hasErrorClasses ? "sc_caught_to_string" : "runtime::caught_to_string"}(&caught);`,
    "            drop(caught);",
    "            (false, Some(message), false)",
    ...(options.usesProcessUncaughtListeners ? ["            }"] : []),
    "        },",
    "    };",
  );
  // Install Node's pending-entry fallback before exit listeners. An explicit
  // nonzero status wins, and listeners may subsequently override even to zero.
  lines.push("    if _sc_unsettled_tla && _sc_uncaught.is_none() && !_sc_unhandled_rejection && runtime::process_exit_code() == 0 { runtime::process_exit_code_set(13.0); }");
  if (options.usesProcessExitListeners) {
    lines.push("    sc_process_run_exit(if _sc_uncaught.is_some() || _sc_unhandled_rejection { 1.0 } else { f64::from(runtime::process_exit_code()) });");
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
    "    let _sc_exit_code = runtime::process_exit_code();",
    "    if _sc_exit_code != 0 { std::process::exit(_sc_exit_code); }",
    "}",
  );
  return lines;
}
