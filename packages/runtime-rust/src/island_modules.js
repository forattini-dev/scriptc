/* The island's CommonJS module system, mirrored from the C island's
 * bootstrap (scr_island.c, isl_modules_bootstrap).
 *
 * This is the module SYSTEM only — no Node builtin shims live here yet,
 * so `builtins` stays empty and every `node:*` require takes the
 * does-not-provide throw. The shape is the shims' contract: they will
 * register memoized factories on `builtins` and nothing else changes.
 *
 * Evaluates to a function taking the host bridge (`source`, `resolve`)
 * and installing `globalThis.__scr_require`. */
(function (host) {
  const cache = Object.create(null);
  const builtins = Object.create(null);
  /* Node's require stack: each CJS module remembers its FIRST requirer
   * (module.parent / moduleParentCache — the chain is static, captured
   * at first load, not the dynamic call stack), and a failing resolution
   * reports the requiring module plus its parent chain. Modules the ES
   * graph pulls in have no parent, exactly like Node's ESM→CJS
   * boundary. */
  const parents = Object.create(null);
  const requireStackOf = (from) => {
    const stack = [];
    for (let m = from; m !== undefined; m = parents[m]) stack.push(m);
    return stack;
  };
  /* Node resolves core modules unconditionally, before node_modules and
   * never through file edges — so a require the build-time walk could
   * not see (a non-literal specifier) still reaches the shims here.
   * Everything else unresolved throws Node's require-time
   * MODULE_NOT_FOUND shape, surfacing lazily at the CALL, which is the
   * only point Node would have loaded the module either: the message
   * carries the live Require stack, plus the code and requireStack
   * properties. Unshimmed BUILTINS reached through the edge table land
   * on their node: keys and take requireKey's does-not-provide throw
   * instead. */
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
     * deletes it so a later require re-evaluates. */
    try {
      fn.call(mod.exports, mod.exports, req, mod, key, dir);
    } catch (e) {
      delete cache[key];
      delete parents[key];
      throw e;
    }
    return mod.exports;
  };
  globalThis.__scr_require = requireKey;
})
