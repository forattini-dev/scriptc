import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { expect, test } from "vitest";

const prelude = readFileSync(new URL("../src/island-js/01-prelude.js", import.meta.url), "utf8");

test.each(["missing", "existing"])("WebAssembly policy applies with %s engine globals", async (presence) => {
  const context = createContext({});
  if (presence === "missing") runInContext("globalThis.WebAssembly = undefined", context);
  // Exercise the maintained bootstrap part in a real realm; the rest of
  // the bootstrap registers Node builtins and is irrelevant to this policy.
  runInContext(`(${prelude}\n})({})`, context);
  const result: unknown = await runInContext(`(async () => {
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
  })()`, context);
  expect(result).toBe(
    "compile:true|instantiate:true|compileStreaming:true|instantiateStreaming:true|" +
    "Module:true|Instance:true|Memory:true|Table:true|Global:true|" +
    "RuntimeError:true|CompileError:true|LinkError:true|valid:false",
  );
});
