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
    let defaultResultOrder = 'verbatim';
    const getDefaultResultOrder = () => defaultResultOrder;
    const setDefaultResultOrder = (order) => {
      if (!['verbatim', 'ipv4first', 'ipv6first'].includes(order)) throw new TypeError('Invalid DNS result order: ' + order);
      defaultResultOrder = order;
    };
    const getServers = () => [];
    const setServers = () => {};
    const queryMethods = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse'];
    const promises = {
      lookup: pFence('lookup'), lookupService: pFence('lookupService'),
      getServers, setServers, getDefaultResultOrder, setDefaultResultOrder,
    };
    class Resolver {
      constructor() {}
      getServers() { return getServers(); }
      setServers(servers) { return setServers(servers); }
      cancel() {}
    }
    const PromiseResolver = class Resolver {
      getServers() { return getServers(); }
      setServers(servers) { return setServers(servers); }
      cancel() {}
    };
    promises.Resolver = PromiseResolver;
    const d = {
      lookup: cbFence('lookup'), lookupService: cbFence('lookupService'),
      getServers, setServers, getDefaultResultOrder, setDefaultResultOrder,
      Resolver, promises, ADDRCONFIG: 1024, V4MAPPED: 2048, ALL: 256,
    };
    for (const m of queryMethods) {
      Resolver.prototype[m] = cbFence(m);
      PromiseResolver.prototype[m] = pFence(m);
      d[m] = cbFence(m);
      promises[m] = pFence(m);
    }
    for (const name of ['NODATA', 'FORMERR', 'SERVFAIL', 'NOTFOUND', 'NOTIMP', 'REFUSED', 'BADQUERY', 'BADNAME', 'BADFAMILY', 'BADRESP', 'CONNREFUSED', 'TIMEOUT', 'EOF', 'FILE', 'NOMEM', 'DESTRUCTION', 'BADSTR', 'BADFLAGS', 'NONAME', 'BADHINTS', 'NOTINITIALIZED', 'LOADIPHLPAPI', 'ADDRGETNETWORKPARAMS', 'CANCELLED']) {
      const value = name === 'EOF' ? name : 'E' + name;
      d[name] = value;
      promises[name] = value;
    }
    d.default = d;
    return d;
  });
  builtins['dns/promises'] = memo(() => builtins.dns().promises);
