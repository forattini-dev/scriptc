  builtins.module = memo(() => {
    /* createRequire over the embedded tables: the base may be a file URL
     * or a plain path (Node accepts both — embedded module keys are
     * realpaths, import.meta.url is their file:// form); resolution walks
     * the base FILE's build-time edges and "node:" specifiers go straight
     * to the shims. The Emscripten factory pattern
     * (createRequire(import.meta.url) then require("node:fs")) works
     * end-to-end. */
    const createRequire = (base) => {
      let key = String(base);
      if (key.startsWith('file://')) key = decodeURIComponent(key.slice(7));
    /* The base file is the created require's parent, like Node: modules
     * it loads report it in their require stacks. */
      const req = (spec) => requireKey(spec.startsWith('node:') ? spec : resolveFrom(key, spec), key);
      req.cache = cache;
      return req;
    };
    /* builtinModules/isBuiltin answer Node's QUESTION ("is this name a
     * Node builtin?") with Node's full list — resolution of unshimmed
     * ones still fails lazily at the call, the island's documented
     * shape. */
    const builtinModules = ['assert','assert/strict','async_hooks','buffer','child_process','cluster','console','constants','crypto','dgram','diagnostics_channel','dns','dns/promises','domain','events','fs','fs/promises','http','http2','https','inspector','inspector/promises','module','net','os','path','path/posix','path/win32','perf_hooks','process','punycode','querystring','readline','readline/promises','repl','stream','stream/consumers','stream/promises','stream/web','string_decoder','sys','timers','timers/promises','tls','trace_events','tty','url','util','util/types','v8','vm','wasi','worker_threads','zlib'];
    const isBuiltin = (name) => {
      const n = String(name);
      return n.startsWith('node:') ? builtinModules.includes(n.slice(5)) : builtinModules.includes(n);
    };
    const m = {
      createRequire,
      builtinModules,
      isBuiltin,
      syncBuiltinESMExports: () => {},
      register: () => {
        throw new Error('module.register is not available in the scriptc island');
      },
      findSourceMap: () => undefined,
    };
    m.default = m;
    return m;
  });
