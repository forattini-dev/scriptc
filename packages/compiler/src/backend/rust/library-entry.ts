import type { IrGlobal, IrLibSection } from "../../ir/nodes.js";
import { mangleFnClosure, mangleFunction, mangleGlobal } from "../mangle.js";

export interface RustLibraryEntryOptions {
  readonly lib: IrLibSection;
  readonly entryName: string;
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
    default: return unsupported(`library return class '${cls}'`);
  }
}

/** Emit the first library-mode ABI slice: initialization, collection, and
 * scalar export wrappers. Buffer ownership and callback channels remain
 * explicit tier refusals until their public-seam cycles land. */
export function emitRustLibraryEntries(options: RustLibraryEntryOptions): string[] {
  const { lib, unsupported } = options;
  if ((lib.callbacks?.length ?? 0) > 0) unsupported("library callback channels");
  if (lib.identity !== undefined) unsupported("library sidecar identity");

  const lines = [
    `std::thread_local! {`,
    `    static SC_LIBRARY_INITIALIZED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };`,
    `}`,
  ];
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
  lines.push(
    "",
    `#[unsafe(no_mangle)]`,
    `pub extern "C" fn ${lib.sinkRegisterSymbol}(`,
    `    _sink: Option<extern "C" fn(*mut std::ffi::c_void, *const u8, usize, u64)>,`,
    `    _context: *mut std::ffi::c_void,`,
    `) {}`,
    "",
    `#[unsafe(no_mangle)]`,
    `pub extern "C" fn ${lib.initSymbol}() {`,
    `    let sc_was_initialized = SC_LIBRARY_INITIALIZED.with(|slot| slot.replace(true));`,
    ...options.globals.map((global) => `    ${resetGlobal(global, unsupported)}`),
    ...options.internedClosureNames.map(
      (name) => `    ${mangleFnClosure(name)}.with(|slot| *slot.borrow_mut() = None);`,
    ),
    `    if sc_was_initialized { runtime::finish(); }`,
    `    runtime::init();`,
    `    ${mangleFunction(options.entryName)}();`,
    `}`,
  );

  if (lib.collectSymbol !== null) {
    lines.push(
      "",
      `#[unsafe(no_mangle)]`,
      `pub extern "C" fn ${lib.collectSymbol}() {`,
      `    runtime::collect_cycles();`,
      `}`,
    );
  }
  if (lib.resultResetSymbol !== null) {
    lines.push(
      "",
      `#[unsafe(no_mangle)]`,
      `pub extern "C" fn ${lib.resultResetSymbol}() {}`,
    );
  }

  for (const entry of lib.exports) {
    const params = entry.params.flatMap((cls, index) =>
      cls === "string"
        ? [`sc_arg_${index}_ptr: *const u8`, `sc_arg_${index}_len: usize`]
        : [`sc_arg_${index}: ${parameterType(cls, unsupported)}`]
    );
    const args = entry.params.map(
      (cls, index) => parameterValue(`sc_arg_${index}`, cls, unsupported),
    );
    const call = `${mangleFunction(entry.fnName)}(${args.join(", ")})`;
    const result = entry.returns === "bool" ? `u8::from(${call})` : call;
    lines.push(
      "",
      `#[unsafe(no_mangle)]`,
      `pub extern "C" fn ${entry.symbol}(${params.join(", ")})${returnType(entry.returns, unsupported)} {`,
      entry.returns === "void" ? `    ${result};` : `    ${result}`,
      `}`,
    );
  }
  return lines;
}
