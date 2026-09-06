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
    /* Explicit resource management (TC39 `using`): the engine compiles
     * the declarations, and Effect-style code reaches for the
     * DisposableStack/AsyncDisposableStack containers and SuppressedError.
     * quickjs-ng ships them; boa does not yet, so the prelude carries a
     * spec-shaped implementation where the engine has none (the `using`
     * desugaring itself needs only Symbol.dispose/asyncDispose, which both
     * engines define). Disposal runs LIFO; an error thrown while a previous
     * error is in flight wraps both in SuppressedError. */
  if (typeof globalThis.SuppressedError === 'undefined') {
    class SuppressedError extends Error {
      constructor(error, suppressed, message) {
        super(message);
        this.name = 'SuppressedError';
        this.error = error;
        this.suppressed = suppressed;
      }
    }
    globalThis.SuppressedError = SuppressedError;
  }
  if (typeof Symbol.dispose === 'undefined') Symbol.dispose = Symbol('Symbol.dispose');
  if (typeof Symbol.asyncDispose === 'undefined') Symbol.asyncDispose = Symbol('Symbol.asyncDispose');
  if (typeof globalThis.DisposableStack === 'undefined') {
    const disposeMethod = (value, sym, name) => {
      if (value === null || value === undefined) return null;
      const m = value[sym];
      if (typeof m !== 'function') throw new TypeError(name + ': value is not disposable');
      return () => m.call(value);
    };
    const runLifo = (stack) => {
      let pending = false;
      let error;
      while (stack.length > 0) {
        const fn = stack.pop();
        try { fn(); } catch (e) {
          error = pending ? new globalThis.SuppressedError(e, error, 'An error was suppressed during disposal') : e;
          pending = true;
        }
      }
      if (pending) throw error;
    };
    class DisposableStack {
      #stack = [];
      #disposed = false;
      get disposed() { return this.#disposed; }
      #check() { if (this.#disposed) throw new ReferenceError('DisposableStack already disposed'); }
      use(value) {
        this.#check();
        const fn = disposeMethod(value, Symbol.dispose, 'DisposableStack.use');
        if (fn !== null) this.#stack.push(fn);
        return value;
      }
      adopt(value, onDispose) {
        this.#check();
        if (typeof onDispose !== 'function') throw new TypeError('DisposableStack.adopt: onDispose is not a function');
        this.#stack.push(() => onDispose(value));
        return value;
      }
      defer(onDispose) {
        this.#check();
        if (typeof onDispose !== 'function') throw new TypeError('DisposableStack.defer: onDispose is not a function');
        this.#stack.push(onDispose);
      }
      move() {
        this.#check();
        const next = new DisposableStack();
        next.#stack = this.#stack;
        this.#stack = [];
        this.#disposed = true;
        return next;
      }
      dispose() {
        if (this.#disposed) return;
        this.#disposed = true;
        const stack = this.#stack;
        this.#stack = [];
        runLifo(stack);
      }
      [Symbol.dispose]() { this.dispose(); }
      get [Symbol.toStringTag]() { return 'DisposableStack'; }
    }
    class AsyncDisposableStack {
      #stack = [];
      #disposed = false;
      get disposed() { return this.#disposed; }
      #check() { if (this.#disposed) throw new ReferenceError('AsyncDisposableStack already disposed'); }
      use(value) {
        this.#check();
        if (value === null || value === undefined) return value;
        const asyncM = value[Symbol.asyncDispose];
        const syncM = value[Symbol.dispose];
        const m = typeof asyncM === 'function' ? asyncM : syncM;
        if (typeof m !== 'function') throw new TypeError('AsyncDisposableStack.use: value is not disposable');
        this.#stack.push(async () => { await m.call(value); });
        return value;
      }
      adopt(value, onDispose) {
        this.#check();
        if (typeof onDispose !== 'function') throw new TypeError('AsyncDisposableStack.adopt: onDispose is not a function');
        this.#stack.push(async () => { await onDispose(value); });
        return value;
      }
      defer(onDispose) {
        this.#check();
        if (typeof onDispose !== 'function') throw new TypeError('AsyncDisposableStack.defer: onDispose is not a function');
        this.#stack.push(async () => { await onDispose(); });
      }
      move() {
        this.#check();
        const next = new AsyncDisposableStack();
        next.#stack = this.#stack;
        this.#stack = [];
        this.#disposed = true;
        return next;
      }
      async disposeAsync() {
        if (this.#disposed) return;
        this.#disposed = true;
        const stack = this.#stack;
        this.#stack = [];
        let pending = false;
        let error;
        while (stack.length > 0) {
          const fn = stack.pop();
          try { await fn(); } catch (e) {
            error = pending ? new globalThis.SuppressedError(e, error, 'An error was suppressed during disposal') : e;
            pending = true;
          }
        }
        if (pending) throw error;
      }
      [Symbol.asyncDispose]() { return this.disposeAsync(); }
      get [Symbol.toStringTag]() { return 'AsyncDisposableStack'; }
    }
    globalThis.DisposableStack = DisposableStack;
    globalThis.AsyncDisposableStack = AsyncDisposableStack;
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
      /* V8 ships a complete CallSite whose toString is not configurable;
       * only an engine that lacks it (boa) gets Node's rendering. */
      const own = Object.getOwnPropertyDescriptor(proto, 'toString');
      if (!own || own.configurable) Object.defineProperty(proto, 'toString', {
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
    /* Bun runtime modules under --target bun (`bun`, `bun:sqlite`,
     * `bun:ffi`, ...): the island has no implementation, so each answers
     * a TRAP object — every member reads as a callable/constructible
     * proxy whose invocation throws the same "requires the Bun runtime"
     * error the static tier's trap-on-call raises, and whose property
     * reads keep answering traps (so `FFIType.ptr`, destructuring, and
     * `typeof Database === 'function'` all behave until something is
     * actually called). The `bun` module's node:url re-exports are real
     * (bun-types declares them so; the static tier aliases them too).
     * The compiler rewrites embedded ESM `import ... from "bun:x"` into
     * reads of this table; CJS `require("bun:x")` reaches it through
     * resolveFrom/requireKey below. Under a Node target nothing answers:
     * Node itself has no such module. */
  const bunTrapMember = (spec, path) => {
    const throwTrap = () => {
      throw new Error("the '" + path + "' of '" + spec + "' is not available in a compiled binary (requires the Bun runtime)");
    };
    return new Proxy(function scriptcBunTrap() {}, {
      apply: throwTrap,
      construct: throwTrap,
      get: (_t, prop) => {
        if (prop === Symbol.toPrimitive) return () => '[bun trap ' + path + ']';
        if (prop === 'then') return undefined;
        if (typeof prop === 'symbol') return undefined;
        return bunTrapMember(spec, path + '.' + String(prop));
      },
    });
  };
  const bunTrapModules = Object.create(null);
  /* Intl.NumberFormat currency and percent styles over an engine whose
   * NumberFormat formats decimals but not currencies (boa's `format`
   * answers "unimplemented" for style: "currency"; percent formats as
   * 0). Feature-detected, so an engine with full ICU (quickjs-ng builds
   * without Intl take a different path entirely) keeps its own. The
   * decimal formatting — grouping, rounding, fraction digits — stays the
   * engine's; only the symbol, the percent scaling, and the currency's
   * default digits are spelled here, for the en-style symbol-first
   * pattern redcode's "$1,234.50" relies on. */
  if (typeof globalThis.Intl !== 'undefined' && typeof globalThis.Intl.NumberFormat === 'function') {
    const Native = globalThis.Intl.NumberFormat;
    let needsShim = false;
    try {
      needsShim = new Native('en-US', { style: 'currency', currency: 'USD' }).format(1) !== '$1.00'
        || new Native('en-US', { style: 'percent' }).format(0.5) !== '50%';
    } catch (e) {
      needsShim = true;
    }
    if (needsShim) {
      const symbols = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: 'CN¥', BRL: 'R$', INR: '₹', KRW: '₩', CAD: 'CA$', AUD: 'A$', MXN: 'MX$', CHF: 'CHF\u00a0', SEK: 'SEK\u00a0', NZD: 'NZ$', HKD: 'HK$', SGD: 'SGD\u00a0' };
      const zeroDigit = new Set(['JPY', 'KRW', 'CLP', 'ISK', 'VND', 'HUF']);
      function ShimNumberFormat(locales, options) {
        const opts = Object.assign({}, options || {});
        const style = opts.style || 'decimal';
        if (style !== 'currency' && style !== 'percent') return new Native(locales, options);
        const currency = style === 'currency' ? String(opts.currency || '').toUpperCase() : '';
        if (style === 'currency' && currency === '') throw new TypeError('Currency code is required with currency style.');
        const digits = style === 'currency' ? (zeroDigit.has(currency) ? 0 : 2) : 0;
        const inner = Object.assign({}, opts);
        delete inner.style; delete inner.currency; delete inner.currencyDisplay; delete inner.currencySign;
        if (inner.minimumFractionDigits === undefined && inner.maximumFractionDigits === undefined) {
          inner.minimumFractionDigits = digits;
          inner.maximumFractionDigits = digits;
        } else {
          if (inner.minimumFractionDigits === undefined) inner.minimumFractionDigits = Math.min(digits, inner.maximumFractionDigits);
          if (inner.maximumFractionDigits === undefined) inner.maximumFractionDigits = Math.max(digits, inner.minimumFractionDigits);
        }
        const decimal = new Native(locales, inner);
        const symbol = style === 'currency' ? (symbols[currency] || currency + '\u00a0') : '';
        const format = (value) => {
          const n = Number(value);
          if (style === 'percent') return decimal.format(n * 100) + '%';
          const negative = n < 0 || Object.is(n, -0);
          const body = decimal.format(Math.abs(n));
          return (negative ? '-' : '') + symbol + body;
        };
        /* Own data properties (the native prototype's `format` is a
         * setter-less accessor, so an inheriting object could not assign
         * it); the shim's prototype is its own, not the native one. */
        const self = Object.create(ShimNumberFormat.prototype);
        Object.defineProperty(self, 'format', { value: format, configurable: true, writable: true });
        Object.defineProperty(self, 'formatToParts', { value: (value) => [{ type: 'literal', value: format(value) }], configurable: true, writable: true });
        Object.defineProperty(self, 'resolvedOptions', { value: () => Object.assign(decimal.resolvedOptions(), { style }, style === 'currency' ? { currency, currencyDisplay: 'symbol', currencySign: 'standard' } : {}), configurable: true, writable: true });
        return self;
      }
      ShimNumberFormat.prototype = { constructor: ShimNumberFormat, [Symbol.toStringTag]: 'Intl.NumberFormat' };
      ShimNumberFormat.supportedLocalesOf = Native.supportedLocalesOf.bind(Native);
      Object.defineProperty(ShimNumberFormat, 'name', { value: 'NumberFormat' });
      globalThis.Intl.NumberFormat = ShimNumberFormat;
    }
  }

  globalThis.__scr_bun_trap = (spec) => {
    const hit = bunTrapModules[spec];
    if (hit) return hit;
    const real = spec === 'bun' && builtins.url
      ? { pathToFileURL: builtins.url().pathToFileURL, fileURLToPath: builtins.url().fileURLToPath }
      : {};
    const mod = new Proxy(real, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (prop === '__esModule') return true;
        if (prop === 'default') return mod;
        if (prop === 'then') return undefined;
        if (typeof prop === 'symbol') return undefined;
        return bunTrapMember(spec, String(prop));
      },
      has: () => true,
    });
    bunTrapModules[spec] = mod;
    return mod;
  };
  const isBunSpec = (spec) => globalThis.__scr_runtime_target === 'bun' && (spec === 'bun' || spec.startsWith('bun:'));
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
      if (isBunSpec(spec)) return spec;
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
    if (isBunSpec(key)) return globalThis.__scr_bun_trap(key);
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
    /* A host that compiles natively (the V8 island: zero-copy source,
     * code cache across runs, the file's name on the wrapper) answers the
     * wrapper itself; the C island builds it here. */
    const fn = (typeof host.compileModule === 'function' && host.compileModule(key)) ||
      new Function('exports', 'require', 'module', '__filename', '__dirname', src);
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
