import type { IrGlobal, IrLibSection } from "../../ir/nodes.js";
import { mangleFnClosure, mangleFunction, mangleGlobal } from "../mangle.js";

export interface RustLibraryEntryOptions {
  readonly lib: IrLibSection;
  readonly entryName: string;
  readonly hasErrorClasses: boolean;
  readonly globals: readonly IrGlobal[];
  readonly internedClosureNames: readonly string[];
  readonly unsupported: (kind: string) => never;
}

function resetGlobal(global: IrGlobal, unsupported: (kind: string) => never): string {
  const name = mangleGlobal(global.id);
  switch (global.type.kind) {
    case "f64":
    case "date": return `${name}.with(|slot| slot.set(0.0));`;
    case "bool": return `${name}.with(|slot| slot.set(false));`;
    case "classval": return `${name}.with(|slot| slot.set(0));`;
    case "string":
      return `${name}.with(|slot| *slot.borrow_mut() = runtime::empty_string());`;
    case "array":
    case "bytes":
    case "stats":
    case "fileHandle":
    case "spawnRes":
    case "child":
    case "childStream":
    case "fsWatcher":
    case "netServer":
    case "netSocket":
    case "dgramSocket":
    case "httpReq":
    case "httpRes":
    case "httpClientReq":
    case "secureCtx":
    case "map":
    case "set":
    case "record":
    case "object":
    case "union":
    case "func":
    case "promise":
    case "generator":
    case "regex":
    case "symbol":
    case "url":
    case "searchParams":
    case "dyn":
    case "jsval":
      return `${name}.with(|slot| *slot.borrow_mut() = None);`;
    default:
      return unsupported(`library global type '${global.type.kind}'`);
  }
}

function parameterType(
  cls: IrLibSection["exports"][number]["params"][number],
  unsupported: (kind: string) => never,
): string {
  switch (cls) {
    case "f64": return "f64";
    case "bool":
    case "u8": return "u8";
    case "u32": return "u32";
    case "i32": return "i32";
    default: return unsupported(`library parameter class '${cls}'`);
  }
}

function parameterValue(
  name: string,
  cls: IrLibSection["exports"][number]["params"][number],
  unsupported: (kind: string) => never,
): string {
  switch (cls) {
    case "f64": return name;
    case "bool": return `${name} != 0`;
    case "u8":
    case "u32":
    case "i32": return `f64::from(${name})`;
    case "string": return `sc_library_string_in(${name}_ptr, ${name}_len)`;
    case "bytes": return `sc_library_bytes_in(${name}_ptr, ${name}_len)`;
    default: return unsupported(`library parameter class '${cls}'`);
  }
}

function returnType(
  cls: IrLibSection["exports"][number]["returns"],
  unsupported: (kind: string) => never,
): string {
  switch (cls) {
    case "void": return "";
    case "f64": return " -> f64";
    case "bool": return " -> u8";
    case "string": return "";
    case "bytes": return "";
    default: return unsupported(`library return class '${cls}'`);
  }
}

/** Emit the library-mode ABI boundary: initialization, collection, export
 * wrappers, result ownership, panic delivery, and host callbacks. */
export function emitRustLibraryEntries(options: RustLibraryEntryOptions): string[] {
  const { lib, unsupported } = options;

  const hasResults = lib.exports.some(
    (entry) => entry.returns === "string" || entry.returns === "bytes",
  );
  const lines = [
    `unsafe extern "C" {`,
    `    fn fflush(stream: *mut std::ffi::c_void) -> i32;`,
    `}`,
    "",
    `fn sc_library_host_entry() {`,
    `    unsafe { fflush(std::ptr::null_mut()); }`,
    `}`,
    "",
    `type ScLibrarySink = extern "C" fn(*mut std::ffi::c_void, *const u8, usize, u64);`,
    ...(lib.callbacks?.length
      ? [`type ScLibraryRawCallback = unsafe extern "C" fn();`,
        `#[derive(Clone, Copy)]`,
        `struct ScLibraryCallback {`,
        `    callback: Option<ScLibraryRawCallback>,`,
        `    context: *mut std::ffi::c_void,`,
        `}`]
      : []),
    "",
    `std::thread_local! {`,
    `    static SC_LIBRARY_INITIALIZED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };`,
    `    static SC_LIBRARY_POISONED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };`,
    `    static SC_LIBRARY_SINK: std::cell::Cell<Option<ScLibrarySink>> = const { std::cell::Cell::new(None) };`,
    `    static SC_LIBRARY_SINK_CONTEXT: std::cell::Cell<*mut std::ffi::c_void> = const { std::cell::Cell::new(std::ptr::null_mut()) };`,
    ...(lib.callbacks?.length
      ? [`    static SC_LIBRARY_CALLBACKS: std::cell::RefCell<[ScLibraryCallback; ${lib.callbacks.length}]> = const { std::cell::RefCell::new([ScLibraryCallback { callback: None, context: std::ptr::null_mut() }; ${lib.callbacks.length}]) };`,
        `    static SC_LIBRARY_CALLBACK_DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };`]
      : []),
    ...(hasResults
      ? [`    static SC_LIBRARY_RESULTS: std::cell::RefCell<Vec<Box<[u8]>>> = const { std::cell::RefCell::new(Vec::new()) };`]
      : []),
    `}`,
  ];
  lines.push(
    "",
    ...(lib.callbacks?.length
      ? [`fn sc_library_check_reentry(symbol: &'static str) {`,
        `    if SC_LIBRARY_CALLBACK_DEPTH.with(std::cell::Cell::get) != 0 {`,
        `        sc_library_deliver("scriptc: library entry called from a host callback\n", "SC4019", symbol);`,
        `    }`,
        `}`,
        ""]
      : []),
    `fn sc_library_check_entry(symbol: &'static str) {`,
    `    if SC_LIBRARY_POISONED.with(std::cell::Cell::get) { std::process::abort(); }`,
    ...(lib.callbacks?.length
      ? [`    sc_library_check_reentry(symbol);`]
      : []),
    `}`,
    "",
    ...(lib.trapOverlays.length
      ? [`fn sc_library_trap_overlay(code: &str) -> (Option<&'static str>, Option<&'static str>) {`,
        `    match code {`,
        ...lib.trapOverlays.map((overlay) =>
          `        ${JSON.stringify(overlay.code)} => (${overlay.teaching === undefined ? "None" : `Some(${JSON.stringify(overlay.teaching)})`}, ${overlay.remediation === undefined ? "None" : `Some(${JSON.stringify(overlay.remediation)})`}),`
        ),
        `        _ => (None, None),`,
        `    }`,
        `}`,
        ""]
      : []),
    `fn sc_library_deliver(text: &str, code: &str, symbol: &'static str) -> ! {`,
    ...(lib.trapOverlays.length
      ? [`    let (teaching, remediation) = sc_library_trap_overlay(code);`,
        `    let text = teaching.unwrap_or(text);`]
      : []),
    `    let mut message = vec![1_u8];`,
    `    message.extend_from_slice(text.as_bytes());`,
    `    message.push(0x1f);`,
    `    message.extend_from_slice(code.as_bytes());`,
    `    message.push(0x1f);`,
    `    message.extend_from_slice(symbol.as_bytes());`,
    ...(lib.trapOverlays.length
      ? [`    if let Some(remediation) = remediation {`,
        `        message.push(0x1f);`,
        `        message.extend_from_slice(remediation.as_bytes());`,
        `    }`]
      : []),
    `    SC_LIBRARY_POISONED.with(|poisoned| poisoned.set(true));`,
    `    let sink = SC_LIBRARY_SINK.with(std::cell::Cell::get);`,
    `    let context = SC_LIBRARY_SINK_CONTEXT.with(std::cell::Cell::get);`,
    `    let Some(sink) = sink else { std::process::abort(); };`,
    `    sink(context, message.as_ptr(), message.len(), message.as_ptr() as usize as u64);`,
    `    std::process::abort();`,
    `}`,
    "",
    `fn sc_library_escape(payload: Box<dyn std::any::Any + Send>, symbol: &'static str) -> ! {`,
    `    let payload = match runtime::take_runtime_trap(payload) {`,
    `        Ok((text, code)) => return sc_library_deliver(&text, code, symbol),`,
    `        Err(payload) => payload,`,
    `    };`,
    `    let caught = runtime::caught_from_panic(payload);`,
    `    if let Some(code) = runtime::caught_library_trap_code(&caught) {`,
    `        let reason = ${options.hasErrorClasses ? "sc_caught_to_string" : "runtime::caught_to_string"}(&caught);`,
    `        drop(caught);`,
    `        return sc_library_deliver(&format!("scriptc: {}\\n", reason), code, symbol);`,
    `    }`,
    `    if runtime::caught_error_code(&caught).as_deref() == Some("SC4025") {`,
    `        let text = runtime::caught_error_message(&caught);`,
    `        return sc_library_deliver(text.as_ref(), "SC4025", symbol);`,
    `    }`,
    `    let reason = ${options.hasErrorClasses ? "sc_caught_to_string" : "runtime::caught_to_string"}(&caught);`,
    `    drop(caught);`,
    `    sc_library_deliver(&format!("Uncaught {}\\n", reason), "SC4013", symbol);`,
    `}`,
    "",
    `fn sc_library_call<T>(symbol: &'static str, call: impl FnOnce() -> T) -> T {`,
    `    sc_library_check_entry(symbol);`,
    `    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)) {`,
    `        Ok(value) => value,`,
    `        Err(payload) => sc_library_escape(payload, symbol),`,
    `    }`,
    `}`,
  );
  if (lib.identity !== undefined) {
    lines.push(
      "",
      `#[unsafe(no_mangle)]`,
      `pub extern "C" fn ${lib.identity.buildIdSymbol}() -> u64 {`,
      `    0x${lib.identity.buildId}_u64`,
      `}`,
      "",
      `#[unsafe(no_mangle)]`,
      `pub extern "C" fn ${lib.identity.abiVersionSymbol}() -> u32 {`,
      `    ${lib.identity.abiVersion}_u32`,
      `}`,
    );
  }
  if (lib.callbacks?.length) {
    lines.push(
      "",
      `struct ScLibraryCallbackGuard;`,
      `impl ScLibraryCallbackGuard {`,
      `    fn enter() -> Self {`,
      `        SC_LIBRARY_CALLBACK_DEPTH.with(|depth| depth.set(depth.get() + 1));`,
      `        Self`,
      `    }`,
      `}`,
      `impl Drop for ScLibraryCallbackGuard {`,
      `    fn drop(&mut self) {`,
      `        SC_LIBRARY_CALLBACK_DEPTH.with(|depth| depth.set(depth.get() - 1));`,
      `    }`,
      `}`,
      "",
      `fn sc_library_callback(slot: usize) -> Option<(ScLibraryRawCallback, *mut std::ffi::c_void)> {`,
      `    SC_LIBRARY_CALLBACKS.with(|callbacks| {`,
      `        let callback = callbacks.borrow()[slot];`,
      `        callback.callback.map(|function| (function, callback.context))`,
      `    })`,
      `}`,
      "",
      `#[unsafe(no_mangle)]`,
      `pub extern "C" fn ${lib.callbackRegisterSymbol}(`,
      `    name: *const std::ffi::c_char,`,
      `    callback: Option<ScLibraryRawCallback>,`,
      `    context: *mut std::ffi::c_void,`,
      `) -> i32 {`,
      `    sc_library_check_reentry(${JSON.stringify(lib.callbackRegisterSymbol)});`,
      `    if name.is_null() { return -1; }`,
      `    let name = unsafe { std::ffi::CStr::from_ptr(name) }.to_bytes();`,
    );
    for (const callback of lib.callbacks) {
      lines.push(
        `    if name == ${JSON.stringify(callback.name)}.as_bytes() {`,
        `        SC_LIBRARY_CALLBACKS.with(|callbacks| {`,
        `            callbacks.borrow_mut()[${callback.slot}] = ScLibraryCallback { callback, context };`,
        `        });`,
        `        return 0;`,
        `    }`,
      );
    }
    lines.push(`    -1`, `}`);
  }
  if (lib.exports.some((entry) => entry.params.includes("string"))) {
    lines.push(
      "",
      `fn sc_library_string_in(data: *const u8, len: usize) -> runtime::JsString {`,
      `    if len == 0 { return runtime::empty_string(); }`,
      `    assert!(!data.is_null(), "scriptc: NULL library string with nonzero length");`,
      `    let bytes = unsafe { std::slice::from_raw_parts(data, len) };`,
      `    runtime::string(String::from_utf8_lossy(bytes).as_ref())`,
      `}`,
    );
  }
  if (lib.exports.some((entry) => entry.params.includes("bytes"))) {
    lines.push(
      "",
      `fn sc_library_bytes_in(data: *const u8, len: usize) -> runtime::JsBytes<u8> {`,
      `    if len == 0 { return runtime::ffi_bytes_copy_in(&[]); }`,
      `    assert!(!data.is_null(), "scriptc: NULL library bytes with nonzero length");`,
      `    let bytes = unsafe { std::slice::from_raw_parts(data, len) };`,
      `    runtime::ffi_bytes_copy_in(bytes)`,
      `}`,
    );
  }
  if (hasResults) {
    lines.push(
      "",
      `fn sc_library_results_reset() {`,
      `    SC_LIBRARY_RESULTS.with(|results| results.borrow_mut().clear());`,
      `}`,
    );
  }
  if (lib.exports.some((entry) => entry.returns === "string")) {
    lines.push(
      "",
      `fn sc_library_string_out(value: runtime::JsString, out: *mut *const u8, out_len: *mut usize) {`,
      `    let len = value.len();`,
      `    let mut bytes = Vec::with_capacity(len + 1);`,
      `    bytes.extend_from_slice(value.as_bytes());`,
      `    bytes.push(0);`,
      `    let bytes = bytes.into_boxed_slice();`,
      `    let data = bytes.as_ptr();`,
      `    SC_LIBRARY_RESULTS.with(|results| results.borrow_mut().push(bytes));`,
      `    unsafe { out.write(data); out_len.write(len); }`,
      `}`,
    );
  }
  if (lib.exports.some((entry) => entry.returns === "bytes")) {
    lines.push(
      "",
      `fn sc_library_bytes_out(value: runtime::JsBytes<u8>, out: *mut *const u8, out_len: *mut usize) {`,
      `    let bytes = runtime::ffi_bytes_snapshot(&value).into_boxed_slice();`,
      `    let len = bytes.len();`,
      `    let data = bytes.as_ptr();`,
      `    SC_LIBRARY_RESULTS.with(|results| results.borrow_mut().push(bytes));`,
      `    unsafe { out.write(data); out_len.write(len); }`,
      `}`,
    );
  }
  lines.push(
    "",
    `#[unsafe(no_mangle)]`,
    `pub extern "C" fn ${lib.sinkRegisterSymbol}(`,
    `    sink: Option<ScLibrarySink>,`,
    `    context: *mut std::ffi::c_void,`,
    `) {`,
    ...(lib.callbacks?.length
      ? [`    sc_library_check_reentry(${JSON.stringify(lib.sinkRegisterSymbol)});`]
      : []),
    `    SC_LIBRARY_SINK.with(|slot| slot.set(sink));`,
    `    SC_LIBRARY_SINK_CONTEXT.with(|slot| slot.set(context));`,
    `}`,
    "",
    `#[unsafe(no_mangle)]`,
    `pub extern "C" fn ${lib.initSymbol}() {`,
    `    sc_library_host_entry();`,
    `    let sc_was_initialized = SC_LIBRARY_INITIALIZED.with(|slot| slot.replace(true));`,
    ...(hasResults ? [`    sc_library_results_reset();`] : []),
    ...options.globals.map((global) => `    ${resetGlobal(global, unsupported)}`),
    ...options.internedClosureNames.map(
      (name) => `    ${mangleFnClosure(name)}.with(|slot| *slot.borrow_mut() = None);`,
    ),
    `    if sc_was_initialized { runtime::finish(); }`,
    `    runtime::init();`,
    `    sc_library_call(${JSON.stringify(lib.initSymbol)}, || ${mangleFunction(options.entryName)}());`,
    `}`,
  );

  if (lib.collectSymbol !== null) {
    lines.push(
      "",
      `#[unsafe(no_mangle)]`,
      `pub extern "C" fn ${lib.collectSymbol}() {`,
      `    sc_library_host_entry();`,
      `    sc_library_check_entry(${JSON.stringify(lib.collectSymbol)});`,
      ...(hasResults ? [`    sc_library_results_reset();`] : []),
      `    runtime::collect_cycles();`,
      `}`,
    );
  }
  if (lib.resultResetSymbol !== null) {
    lines.push(
      "",
      `#[unsafe(no_mangle)]`,
      `pub extern "C" fn ${lib.resultResetSymbol}() {`,
      `    sc_library_host_entry();`,
      `    sc_library_check_entry(${JSON.stringify(lib.resultResetSymbol)});`,
      ...(hasResults ? [`    sc_library_results_reset();`] : []),
      `}`,
    );
  }

  for (const entry of lib.exports) {
    const params = entry.params.flatMap((cls, index) =>
      cls === "string" || cls === "bytes"
        ? [`sc_arg_${index}_ptr: *const u8`, `sc_arg_${index}_len: usize`]
        : [`sc_arg_${index}: ${parameterType(cls, unsupported)}`]
    );
    const args = entry.params.map(
      (cls, index) => parameterValue(`sc_arg_${index}`, cls, unsupported),
    );
    if (entry.returns === "string" || entry.returns === "bytes") {
      params.push("sc_out: *mut *const u8", "sc_out_len: *mut usize");
    }
    const call = `sc_library_call(${JSON.stringify(entry.symbol)}, || ${mangleFunction(entry.fnName)}(${args.join(", ")}))`;
    const result = entry.returns === "bool" ? `u8::from(${call})` : call;
    lines.push(
      "",
      `#[unsafe(no_mangle)]`,
      `pub extern "C" fn ${entry.symbol}(${params.join(", ")})${returnType(entry.returns, unsupported)} {`,
      `    sc_library_host_entry();`,
      ...(hasResults && lib.resultResetSymbol === null
        ? [`    sc_library_results_reset();`]
        : []),
      entry.returns === "string"
        ? `    sc_library_string_out(${result}, sc_out, sc_out_len);`
        : entry.returns === "bytes"
          ? `    sc_library_bytes_out(${result}, sc_out, sc_out_len);`
        : entry.returns === "void" ? `    ${result};` : `    ${result}`,
      `}`,
    );
  }
  return lines;
}
