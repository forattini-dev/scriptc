  globalThis.process = builtins.process();
    /* Node's Buffer global (and `global` itself) — embedded CJS
     * reaches both without requiring anything. */
  globalThis.Buffer = builtins.buffer().Buffer;
    /* setImmediate/clearImmediate globals (zero-delay timers — no
     * check phase in the island; documented divergence), and the
     * global console upgraded to Node's util.format semantics for
     * npm builds (the web prelude's String() console stays for
     * non-npm islands). */
  if (globalThis.setImmediate === undefined) {
    globalThis.setImmediate = (fn, ...args) => globalThis.setTimeout(fn, 0, ...args);
    globalThis.clearImmediate = (t) => globalThis.clearTimeout(t);
  }
  {
    const fmt = (...a) => builtins.util().formatWithOptions({}, ...a);
    const to = (fd, prefix) => (...a) => { host.write(fd, (prefix || '') + fmt(...a) + '\n'); };
    const c = globalThis.console;
    c.log = to(1);
    c.info = to(1);
    c.debug = to(1);
    c.warn = to(2);
    c.error = to(2);
    c.trace = to(2, 'Trace: ');
  }
  if (globalThis.global === undefined) globalThis.global = globalThis;
  globalThis.__scr_require = requireKey;
  return (key, name) => {
    const exports = requireKey(key);
    if (name === 'default') return exports;
    if (name === '*') {
      const ns = { default: exports };
      for (const k in exports) {
        if (Object.prototype.hasOwnProperty.call(exports, k)) ns[k] = exports[k];
      }
      return ns;
    }
    return exports[name];
  };
}
