    /* node:dns — LOADABLE with Node's surface shape, answers fenced at
     * the call. proxy-agent's pac-resolver (in a real CLI's graph
     * whenever proxy env vars exist) requires dns at LOAD and only calls
     * lookup when a PAC proxy actually resolves — so the module must
     * import cleanly, and the callback-taking members deliver their
     * refusal THROUGH the callback (Node's error channel for dns), which
     * keeps a caller's own error handling alive instead of crashing the
     * call site. promises members reject. No resolver ships: the island
     * has no DNS client — the fence text says so at the only point Node
     * would have queried. */
  builtins.dns = memo(() => {
    const fenceErr = (what) => {
      const e = new Error("node:dns '" + what + "' is not supported in the scriptc island yet");
      e.code = 'ENOTFOUND';
      e.syscall = what;
      return e;
    };
    const cbFence = (what) => (...args) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') { queueMicrotask(() => cb(fenceErr(what))); return; }
      throw fenceErr(what);
    };
    const pFence = (what) => (...args) => Promise.reject(fenceErr(what));
    const promises = {
      lookup: pFence('lookup'), lookupService: pFence('lookupService'),
      resolve: pFence('resolve'), resolve4: pFence('resolve4'), resolve6: pFence('resolve6'),
      resolveCname: pFence('resolveCname'), resolveMx: pFence('resolveMx'),
      resolveNs: pFence('resolveNs'), resolveSrv: pFence('resolveSrv'),
      resolveTxt: pFence('resolveTxt'), reverse: pFence('reverse'),
      getServers: () => [], setServers: () => {},
    };
    class Resolver {
      constructor() {}
      getServers() { return []; }
      setServers() {}
    }
    for (const m of ['resolve', 'resolve4', 'resolve6', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt', 'reverse']) {
      Resolver.prototype[m] = cbFence(m);
    }
    const d = {
      lookup: cbFence('lookup'), lookupService: cbFence('lookupService'),
      resolve: cbFence('resolve'), resolve4: cbFence('resolve4'), resolve6: cbFence('resolve6'),
      resolveCname: cbFence('resolveCname'), resolveMx: cbFence('resolveMx'),
      resolveNs: cbFence('resolveNs'), resolveSrv: cbFence('resolveSrv'),
      resolveTxt: cbFence('resolveTxt'), reverse: cbFence('reverse'),
      getServers: () => [], setServers: () => {},
      Resolver, promises,
      ADDRCONFIG: 1024, V4MAPPED: 2048, ALL: 256,
      NODATA: 'ENODATA', FORMERR: 'EFORMERR', SERVFAIL: 'ESERVFAIL',
      NOTFOUND: 'ENOTFOUND', NOTIMP: 'ENOTIMP', REFUSED: 'EREFUSED',
    };
    d.default = d;
    return d;
  });
