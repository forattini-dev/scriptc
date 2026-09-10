// The WebAssembly stub surface: instantiate REJECTS with the clear
// message (the real API's promise shape — invalid bytes reject, never
// throw synchronously, so eval-time compiles stay lazy exactly as under
// Node), the error classes are REAL Error subclasses (Emscripten's abort
// path constructs one), and validate() answers the feature-detection
// truth.
export async function probe() {
  try {
    await WebAssembly.instantiate(new Uint8Array(4), {});
    return "instantiated";
  } catch (e) {
    return String((e && e.message) || e);
  }
}
export function abortShape() {
  try {
    throw new Error("boom");
  } catch (e) {
    const r = new WebAssembly.RuntimeError("Aborted(" + e + ")");
    return (r instanceof Error) + "|" + r.name + "|" + r.message;
  }
}
export function validated() {
  return String(WebAssembly.validate(new Uint8Array(4)));
}
export async function surface() {
  const results = [];
  const message = (name) => 'WebAssembly.' + name + ' is not supported in scriptc binaries (the embedded engine has no wasm runtime)';
  for (const name of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
    let returned;
    try { returned = WebAssembly[name](new Uint8Array(4), {}); }
    catch { results.push(name + ':sync throw'); continue; }
    try { await returned; results.push(name + ':resolved'); }
    catch (error) { results.push(name + ':' + (error.message === message(name))); }
  }
  for (const name of ['Module', 'Instance', 'Memory', 'Table', 'Global']) {
    try { new WebAssembly[name](); results.push(name + ':constructed'); }
    catch (error) { results.push(name + ':' + (error.message === message(name))); }
  }
  for (const name of ['RuntimeError', 'CompileError', 'LinkError']) {
    const error = new WebAssembly[name]('test');
    results.push(name + ':' + (error instanceof Error && error.name === name && error.message === 'test'));
  }
  results.push('valid:' + WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
  return results.join('|');
}
