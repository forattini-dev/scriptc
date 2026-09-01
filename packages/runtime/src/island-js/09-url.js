  builtins.url = memo(() => {
    /* node:url — the URL/URLSearchParams globals plus the file-path
     * converters riding the static scr_url.c implementations (Node's
     * exact rules), and the legacy parse/format/resolve trio over the
     * WHATWG parser. */
    const fileURLToPath = (u) => {
      const s = typeof u === 'object' && u !== null && 'href' in u ? String(u.href) : String(u);
      return host.urlToPath(s);
    };
    const pathToFileURL = (p) => new globalThis.URL(host.urlFromPath(String(p)));
    const parse = (input, parseQuery) => {
      const out = { protocol: null, slashes: null, auth: null, host: null, port: null,
        hostname: null, hash: null, search: null, query: null, pathname: null, path: null, href: String(input) };
      let u = null;
      try { u = new globalThis.URL(String(input)); } catch (e) { u = null; }
      if (u !== null) {
        out.protocol = u.protocol || null;
        out.slashes = u.href.startsWith(u.protocol + '//') ? true : null;
        out.auth = u.username !== '' ? (u.password !== '' ? u.username + ':' + u.password : u.username) : null;
        out.host = u.host || null;
        out.port = u.port !== '' ? u.port : null;
        out.hostname = u.hostname || null;
        out.hash = u.hash !== '' ? u.hash : null;
        out.search = u.search !== '' ? u.search : null;
        out.query = u.search !== '' ? u.search.slice(1) : null;
        out.pathname = u.pathname || null;
        out.path = (u.pathname || '') + (u.search || '') || null;
        out.href = u.href;
      } else {
        let rest = String(input);
        const hashAt = rest.indexOf('#');
        if (hashAt >= 0) { out.hash = rest.slice(hashAt); rest = rest.slice(0, hashAt); }
        const qAt = rest.indexOf('?');
        if (qAt >= 0) { out.search = rest.slice(qAt); out.query = rest.slice(qAt + 1); rest = rest.slice(0, qAt); }
        out.pathname = rest || null;
        out.path = (rest || '') + (out.search || '') || null;
      }
      if (parseQuery) {
        const q = {};
        for (const [k, v] of new globalThis.URLSearchParams(out.query || '')) {
          if (k in q) { if (Array.isArray(q[k])) q[k].push(v); else q[k] = [q[k], v]; }
          else q[k] = v;
        }
        out.query = q;
      }
      return out;
    };
    const format = (obj) => {
      if (typeof obj === 'string') return obj;
      if (obj !== null && typeof obj === 'object' && typeof obj.href === 'string' && obj instanceof globalThis.URL) return obj.href;
      const protocol = obj.protocol ? (obj.protocol.endsWith(':') ? obj.protocol : obj.protocol + ':') : '';
      const host = obj.host !== undefined && obj.host !== null ? obj.host
        : obj.hostname ? obj.hostname + (obj.port ? ':' + obj.port : '') : '';
      const auth = obj.auth ? obj.auth + '@' : '';
      const slashes = obj.slashes || host !== '' ? '//' : '';
      let pathname = obj.pathname || '';
      if (pathname !== '' && !pathname.startsWith('/') && host !== '') pathname = '/' + pathname;
      let search = obj.search || (obj.query && typeof obj.query === 'object' ? '?' + new globalThis.URLSearchParams(obj.query).toString() : obj.query ? '?' + obj.query : '');
      if (search !== '' && !search.startsWith('?')) search = '?' + search;
      let hash = obj.hash || '';
      if (hash !== '' && !hash.startsWith('#')) hash = '#' + hash;
      return protocol + slashes + auth + host + pathname + search + hash;
    };
    const resolve = (from, to) => {
      const u = new globalThis.URL(String(to), new globalThis.URL(String(from), 'resolve://'));
      if (u.protocol === 'resolve:') return u.pathname + u.search + u.hash;
      return u.href;
    };
    const u = {
      URL: globalThis.URL,
      URLSearchParams: globalThis.URLSearchParams,
      fileURLToPath, pathToFileURL, parse, format, resolve,
    /* IDNA is not carried: ASCII hostnames pass through lowercased
     * (documented divergence for internationalized domains). */
      domainToASCII: (d) => String(d).toLowerCase(),
      domainToUnicode: (d) => String(d).toLowerCase(),
      urlToHttpOptions: (u2) => ({ protocol: u2.protocol, hostname: u2.hostname, hash: u2.hash, search: u2.search, pathname: u2.pathname, path: u2.pathname + (u2.search || ''), href: u2.href, port: u2.port !== '' ? Number(u2.port) : undefined, host: u2.host }),
    };
    u.default = u;
    return u;
  });
