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
    /* The OTHER half of the same gap: an engine with NO
     * Error.captureStackTrace at all (boa). The block above fills in a
     * CallSite class the engine already has; this one synthesizes the
     * whole V8 seam from the engine's own `error.stack` TEXT, because
     * depd — and therefore http-errors, express, router, send,
     * body-parser and serve-static — calls it at module scope and dies
     * on the first `require`. The frames are parsed, not invented: the
     * function name, file and position come from the engine's own trace,
     * and every accessor the engine cannot answer returns the honest
     * empty value rather than throwing. `stack` is an ACCESSOR, so
     * Error.prepareStackTrace is consulted at READ time — V8's laziness,
     * and the only reason depd's set-then-capture-then-read works. */
  if (typeof Error.captureStackTrace !== 'function') {
    class CallSite {
      constructor(name, file, line, column) {
        this._n = name; this._f = file; this._l = line; this._c = column;
      }
      getThis() { return undefined; }
      getTypeName() { return null; }
      getFunction() { return undefined; }
      getFunctionName() { return this._n; }
      getMethodName() { return null; }
      getFileName() { return this._f; }
      getLineNumber() { return this._l; }
      getColumnNumber() { return this._c; }
      getEvalOrigin() { return undefined; }
      getPosition() { return this._c; }
      isToplevel() { return this._n === null; }
      isEval() { return false; }
      isNative() { return this._f === null; }
      isConstructor() { return false; }
      isAsync() { return false; }
      isPromiseAll() { return false; }
      getPromiseIndex() { return null; }
      toString() {
        const where = (this._f === null ? '<anonymous>' : this._f) +
          (this._l === null ? '' : ':' + this._l + (this._c === null ? '' : ':' + this._c));
        return this._n === null ? where : this._n + ' (' + where + ')';
      }
    }
    const parseFrames = (text) => {
      const frames = [];
      for (const raw of String(text === undefined || text === null ? '' : text).split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed.startsWith('at ')) continue;
        let body = trimmed.slice(3).trim();
        let name = null;
        const open = body.lastIndexOf(' (');
        if (open >= 0 && body.endsWith(')')) {
          name = body.slice(0, open);
          body = body.slice(open + 2, -1);
        }
        let file = body;
        let line = null;
        let column = null;
        const at = /:(\d+):(\d+)$/.exec(body);
        if (at !== null) {
          file = body.slice(0, at.index);
          line = Number(at[1]);
          column = Number(at[2]);
        }
        file = file.trim();
        if (file === '' || file === 'native' || file === 'unknown' || file === 'unknown at') file = null;
        frames.push(new CallSite(name === '' || name === null ? null : name, file, line, column));
      }
      return frames;
    };
    if (Error.stackTraceLimit === undefined) Error.stackTraceLimit = 10;
    Error.captureStackTrace = function captureStackTrace(target, constructorOpt) {
      const frames = parseFrames(new Error().stack);
    /* Drop this function's own frame, and everything above the
     * constructor V8 was asked to hide. */
      let cut = frames.length > 0 ? 1 : 0;
      if (typeof constructorOpt === 'function' && constructorOpt.name) {
        for (let i = 0; i < frames.length; i += 1) {
          if (frames[i].getFunctionName() === constructorOpt.name) { cut = i + 1; break; }
        }
      }
      const kept = frames.slice(cut);
      Object.defineProperty(target, 'stack', {
        configurable: true,
        get() {
          const prep = Error.prepareStackTrace;
          if (typeof prep === 'function') return prep(target, kept);
          const head = (target instanceof Error) ? (target.name + ': ' + target.message) : '';
          const body = kept.map((f) => '    at ' + f.toString()).join('\n');
          return head === '' ? body : (body === '' ? head : head + '\n' + body);
        },
        set(value) {
          Object.defineProperty(target, 'stack', { value, writable: true, configurable: true });
        },
      });
      return undefined;
    };
  }
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
