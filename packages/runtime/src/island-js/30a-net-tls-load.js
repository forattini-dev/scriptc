    /* node:net/node:tls — enough to LOAD (eval-time requires succeed,
     * Node's shape); the socket surfaces fence loudly at the call. isIP
     * and friends are real (address validation is common eval-adjacent
     * work). This part is host-independent so both islands can embed it. */
    builtins.net = memo(() => {
      const isIPv4 = (s) => {
        if (typeof s !== 'string') return false;
        const parts = s.split('.');
        if (parts.length !== 4) return false;
        for (const p of parts) {
          if (!/^\d{1,3}$/.test(p)) return false;
          if (p.length > 1 && p[0] === '0') return false;
          if (Number(p) > 255) return false;
        }
        return true;
      };
      const isIPv6 = (s) => {
        if (typeof s !== 'string' || s.indexOf(':') < 0) return false;
        let body = s;
        const lastColon = s.lastIndexOf(':');
        if (s.indexOf('.') >= 0) {
          if (!isIPv4(s.slice(lastColon + 1))) return false;
          body = s.slice(0, lastColon + 1) + '0:0';
        }
        const dbl = body.indexOf('::');
        if (dbl >= 0 && body.indexOf('::', dbl + 1) >= 0) return false;
        const groups = body.split(':');
        if (dbl < 0 && groups.length !== 8) return false;
        if (dbl >= 0 && groups.length > 8) return false;
        for (const g of groups) {
          if (g === '') continue;
          if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
        }
        return true;
      };
      const isIP = (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0);
      const die = (what) => () => {
        throw new Error("node:net '" + what + "' is not supported in the scriptc island yet (the http/https client is)");
      };
      const mod = {
        isIP, isIPv4, isIPv6,
        connect: die('connect'), createConnection: die('createConnection'), createServer: die('createServer'),
        Socket: class Socket { constructor() { die('new Socket')(); } },
        Server: class Server { constructor() { die('new Server')(); } },
      };
      mod.default = mod;
      return mod;
    });
    builtins.tls = memo(() => {
      const die = (what) => () => {
        throw new Error("node:tls '" + what + "' is not supported in the scriptc island yet (the https client is)");
      };
      const mod = {
        connect: die('connect'), createServer: die('createServer'), createSecureContext: die('createSecureContext'),
        TLSSocket: class TLSSocket { constructor() { die('new TLSSocket')(); } },
        rootCertificates: [],
      };
      mod.default = mod;
      return mod;
    });
