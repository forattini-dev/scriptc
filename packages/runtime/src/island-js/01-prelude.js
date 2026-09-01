(host) => {
  'use strict';
    /* The WebAssembly DECISION (SEMANTICS.md, island section): the engine
     * has no wasm runtime, and pretending otherwise is banned. Embedded
     * JS that references WebAssembly (Emscripten factory modules load
     * fine — they are plain JS — and reach WebAssembly.instantiate only
     * when INVOKED) must fail honestly and catchably: a throwing stub
     * with a clear message, plus real Error subclasses for the error
     * types, so Emscripten's own abort path (`new
     * WebAssembly.RuntimeError("Aborted(...)")` inside its catch) still
     * constructs and the factory's ready promise rejects with the
     * Emscripten-shaped error carrying this message — the most
     * Node-plausible catchable failure. validate() answers false, the
     * feature-detection truth. The PROMISE-shaped members (compile/
     * instantiate/-Streaming) REJECT instead of throwing synchronously —
     * the real API's shape (invalid bytes reject, never throw), which
     * keeps eval-time compiles lazy exactly as they are under Node: a
     * module whose top level starts `WebAssembly.compile(...)` (es-module-
     * lexer's `export const init`, undici's lazyllhttp) evaluates fine
     * and fails only where the promise is AWAITED — the code path that
     * actually needed wasm, often behind a feature-detect or fallback
     * catch. The constructor-shaped members stay synchronous throws (so
     * does `new Module()` under real wasm on bad bytes). */
  if (typeof globalThis.WebAssembly === 'undefined') {
    const die = (what) => () => {
      throw new Error('WebAssembly.' + what + ' is not supported in scriptc binaries (the embedded engine has no wasm runtime)');
    };
    /* The reason carries the __scr_wasm_stub marker (non-enumerable):
     * the rejection tracker below SKIPS ledgering it, so a top-level
     * `WebAssembly.compile(...)` chain the program never awaits (es-
     * module-lexer's `export const init`, alive in real CLI
     * graph) stays silent at teardown — under real wasm the compile
     * SUCCEEDS unobserved, so silence is Node's observable — while an
     * actual await site still sees the rejection untouched. The marker
     * must ride the REASON, not the promise: .then() chains derive new
     * unhandled promises carrying the same reason object. */
    const dieAsync = (what) => () => {
      const e = new Error('WebAssembly.' + what + ' is not supported in scriptc binaries (the embedded engine has no wasm runtime)');
      Object.defineProperty(e, '__scr_wasm_stub', { value: true });
      return Promise.reject(e);
    };
    class RuntimeError extends Error {}
    class CompileError extends Error {}
    class LinkError extends Error {}
    RuntimeError.prototype.name = 'RuntimeError';
    CompileError.prototype.name = 'CompileError';
    LinkError.prototype.name = 'LinkError';
    globalThis.WebAssembly = {
      instantiate: dieAsync('instantiate'),
      instantiateStreaming: dieAsync('instantiateStreaming'),
      compile: dieAsync('compile'),
      compileStreaming: dieAsync('compileStreaming'),
      validate: () => false,
      Module: die('Module'),
      Instance: die('Instance'),
      Memory: die('Memory'),
      Table: die('Table'),
      Global: die('Global'),
      RuntimeError, CompileError, LinkError,
    };
  }
    /* V8's structured stack frames (Error.prepareStackTrace's CallSite
     * objects). quickjs-ng ships the CallSite class with only the six
     * accessors it needs for its own trace text — getFileName,
     * getFunctionName, getFunction, getLineNumber, getColumnNumber, plus
     * isNative — and NO isEval/getThis/getTypeName/getMethodName. depd
     * (the deprecation layer under http-errors, and therefore under
     * express, router, send, body-parser and serve-static) calls
     * `callSite.isEval()` in its callSiteLocation the moment
     * `require('depd')('...')` runs at module scope, so every one of
     * those packages died with "not a function" before exporting
     * anything. The vendored engine is not modified (vendor/README.md's
     * contract), so the missing V8 surface is filled in here, on the
     * prototype reached through one captured frame — before any embedded
     * module can evaluate. Values are the honest answers for frames the
     * engine does not retain (no receiver, no eval origin, no method
     * binding): undefined/null, never a throw. toString() gets Node's
     * "name (file:line:col)" text, which depd renders into its trace. */
  if (typeof Error.captureStackTrace === 'function') {
    const proto = (() => {
      const prep = Error.prepareStackTrace;
      try {
        Error.prepareStackTrace = (_e, frames) => frames;
        const holder = {};
        Error.captureStackTrace(holder);
        const frames = holder.stack;
        if (!Array.isArray(frames) || frames.length === 0) return null;
        return Object.getPrototypeOf(frames[0]);
      } catch (e) {
        return null;
      } finally {
        Error.prepareStackTrace = prep;
      }
    })();
    if (proto && typeof proto.getFileName === 'function') {
      const def = (name, fn) => {
        if (typeof proto[name] === 'function') return;
        Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
      };
      def('getThis', function () { return undefined; });
      def('getTypeName', function () { return null; });
      def('getMethodName', function () { return null; });
      def('getEvalOrigin', function () { return undefined; });
      def('getScriptNameOrSourceURL', function () { return this.getFileName(); });
      def('getScriptHash', function () { return ''; });
      def('getEnclosingLineNumber', function () { return this.getLineNumber(); });
      def('getEnclosingColumnNumber', function () { return this.getColumnNumber(); });
      def('getPosition', function () { return 0; });
      def('isEval', function () { return false; });
      def('isConstructor', function () { return false; });
      def('isAsync', function () { return false; });
      def('isPromiseAll', function () { return false; });
      def('getPromiseIndex', function () { return null; });
    /* A frame with no function name is the module/script body — Node's
     * isToplevel() for exactly those. */
      def('isToplevel', function () { return !this.getFunctionName(); });
      Object.defineProperty(proto, 'toString', {
        writable: true,
        configurable: true,
        value: function () {
          if (this.isNative()) return 'native';
          const file = this.getFileName();
          let where = file === null || file === undefined ? '<anonymous>' : String(file);
          const line = this.getLineNumber();
          if (typeof line === 'number' && line >= 0) {
            where += ':' + line;
            const col = this.getColumnNumber();
            if (typeof col === 'number' && col >= 0) where += ':' + col;
          }
          const name = this.getFunctionName();
          return name ? name + ' (' + where + ')' : where;
        },
      });
    }
  }
  const cache = Object.create(null);
  const builtins = Object.create(null);
    /* Node's require stack: each CJS module remembers its FIRST requirer
     * (Node's module.parent / moduleParentCache — the chain is static,
     * captured at first load, not the dynamic call stack), and a failing
     * resolution reports the requiring module plus its parent chain.
     * Entry modules loaded from the compiled (ESM-like) world have no
     * parent, exactly like Node's ESM→CJS boundary. */
  const parents = Object.create(null);
  const requireStackOf = (from) => {
    const stack = [];
    for (let m = from; m !== undefined; m = parents[m]) stack.push(m);
    return stack;
  };
    /* Node resolves core modules unconditionally, before node_modules
     * and never through file edges — so a require the build-time walk
     * could not see (a non-literal specifier) still reaches the shims
     * here. Everything else unresolved throws Node's require-time
     * MODULE_NOT_FOUND shape, surfacing lazily at the CALL, which is the
     * only point Node would have loaded the module either: the message
     * carries the live Require stack, plus the code and requireStack
     * properties. (Unshimmed BUILTINS reached by build-time-visible lazy
     * edges resolve through the edge table to their node: keys and take
     * requireKey's does-not-provide throw below instead.) */
  const resolveFrom = (from, spec) => {
    const to = host.resolve(from, spec);
    if (to === undefined) {
      const name = spec.startsWith('node:') ? spec.slice(5) : spec;
      if (builtins[name]) return 'node:' + name;
      const stack = requireStackOf(from);
      const err = new Error("Cannot find module '" + spec + "'" +
        (stack.length ? '\nRequire stack:\n- ' + stack.join('\n- ') : ''));
      err.code = 'MODULE_NOT_FOUND';
      err.requireStack = stack;
      throw err;
    }
    return to;
  };
  const requireKey = (key, parent) => {
    if (key.startsWith('node:')) {
      const b = builtins[key.slice(5)];
      if (!b) throw new Error("the island does not provide the '" + key + "' builtin");
      return b();
    }
    const hit = cache[key];
    if (hit) return hit.exports;
    const info = host.source(key);
    if (info === undefined) throw new Error("module '" + key + "' is not embedded");
    const src = info[0], format = info[1];
    const mod = { exports: {} };
    cache[key] = mod;
    if (parent !== undefined && !(key in parents)) parents[key] = parent;
    if (format === 2) { mod.exports = JSON.parse(src); return mod.exports; }
    if (format === 0) { delete cache[key]; throw new Error('require() of ES module ' + key); }
    const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src);
    const req = (spec) => requireKey(resolveFrom(key, spec), key);
    req.cache = cache;
    const dir = key.slice(0, key.lastIndexOf('/')) || '/';
    /* A module whose evaluation THROWS leaves no cache entry — Node
     * deletes it so a later require re-evaluates (and a lazy require
     * trap throws EVERY time instead of answering {} on the retry). */
    try {
      fn.call(mod.exports, mod.exports, req, mod, key, dir);
    } catch (e) {
      delete cache[key];
      delete parents[key];
      throw e;
    }
    return mod.exports;
  };
  const memo = (f) => { let v; return () => (v === undefined ? (v = f()) : v); };
