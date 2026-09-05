  /* The Node 24 member surface the shims above leave out, added AFTER
   * every shim is defined and only where a member is still undefined —
   * the C island's native members keep precedence. Packages in a real
   * CLI's graph read these at LOAD (undici: worker_threads'
   * markAsUncloneable; the AI SDKs: util.aborted; graceful-fs: fs.close
   * and friends): a missing member is "not a callable function" at
   * module evaluation, so linking matters even where the answer is a
   * fence. Fences follow each module's own error channel — callbacks
   * for the callback forms, rejections for promises, throws elsewhere. */
  const augment = (name, patch) => {
    const previous = builtins[name];
    if (typeof previous !== 'function') return;
    builtins[name] = memo(() => {
      const mod = previous();
      const add = (key, value) => { if (mod[key] === undefined) mod[key] = value; };
      patch(mod, add);
      return mod;
    });
  };
  const notSupported = (what) => {
    const e = new Error(what + ' is not supported in the scriptc island yet');
    e.code = 'ERR_NOT_SUPPORTED';
    return e;
  };
  const cbFence = (what) => (...args) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') { queueMicrotask(() => cb(notSupported(what))); return; }
    throw notSupported(what);
  };
  const syncFence = (what) => () => { throw notSupported(what); };
  const promiseFence = (what) => () => Promise.reject(notSupported(what));

  augment('worker_threads', (wt, add) => {
    add('markAsUncloneable', () => {});
    add('isMarkedAsUntransferable', () => false);
    add('threadName', 'main');
    add('isInternalThread', false);
    add('postMessageToThread', promiseFence('worker_threads.postMessageToThread'));
    add('moveMessagePortToContext', (port) => port);
    add('BroadcastChannel', globalThis.BroadcastChannel);
  });

  augment('events', (ev, add) => {
    const EventEmitter = ev.EventEmitter || ev;
    add('init', function init() { if (this && !this._events) this._events = Object.create(null); });
    add('captureRejections', false);
    add('usingDomains', false);
    add('getMaxListeners', (emitter) =>
      emitter && typeof emitter.getMaxListeners === 'function' ? emitter.getMaxListeners() : EventEmitter.defaultMaxListeners);
    add('addAbortListener', (signal, listener) => {
      if (!signal || typeof signal.addEventListener !== 'function') throw new TypeError('The "signal" argument must be an instance of AbortSignal');
      if (signal.aborted) { queueMicrotask(() => listener(new Event('abort'))); return { [Symbol.dispose]() {} }; }
      signal.addEventListener('abort', listener, { once: true });
      return { [Symbol.dispose]() { signal.removeEventListener('abort', listener); } };
    });
    if (ev.EventEmitterAsyncResource === undefined) {
      class EventEmitterAsyncResource extends EventEmitter {
        constructor(options) { super(options); this.asyncResource = { asyncId: () => 0, triggerAsyncId: () => 0, runInAsyncScope: (fn, thisArg, ...args) => fn.apply(thisArg, args), emitDestroy: () => {} }; }
        get asyncId() { return 0; }
        get triggerAsyncId() { return 0; }
        emitDestroy() {}
      }
      ev.EventEmitterAsyncResource = EventEmitterAsyncResource;
      if (EventEmitter !== ev) EventEmitter.EventEmitterAsyncResource = EventEmitterAsyncResource;
    }
  });

  augment('util', (u, add) => {
    add('aborted', (signal, resource) => new Promise((resolve) => {
      if (!signal || typeof signal.addEventListener !== 'function') throw new TypeError('The "signal" argument must be an instance of AbortSignal');
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener('abort', () => resolve(), { once: true });
      void resource;
    }));
    add('getCallSites', () => []);
    add('setTraceSigInt', () => {});
    add('transferableAbortController', () => new AbortController());
    add('transferableAbortSignal', (signal) => signal);
    add('diff', syncFence('util.diff'));
    add('parseEnv', (content) => {
      const out = {};
      for (const raw of String(content).split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const m = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        let value = m[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('`') && value.endsWith('`'))) {
          value = value.slice(1, -1);
          if (m[2].trim().startsWith('"')) value = value.replace(/\\n/g, '\n');
        } else {
          value = value.replace(/\s+#.*$/, '');
        }
        out[m[1]] = value;
      }
      return out;
    });
    const errnoNames = { '-2': ['ENOENT', 'no such file or directory'], '-13': ['EACCES', 'permission denied'], '-17': ['EEXIST', 'file already exists'], '-20': ['ENOTDIR', 'not a directory'], '-21': ['EISDIR', 'illegal operation on a directory'], '-22': ['EINVAL', 'invalid argument'], '-32': ['EPIPE', 'broken pipe'], '-98': ['EADDRINUSE', 'address already in use'], '-104': ['ECONNRESET', 'connection reset by peer'], '-110': ['ETIMEDOUT', 'connection timed out'], '-111': ['ECONNREFUSED', 'connection refused'], '-4058': ['ENOENT', 'no such file or directory'] };
    add('getSystemErrorName', (code) => (errnoNames[String(code)] || ['Unknown system error ' + code])[0]);
    add('getSystemErrorMessage', (code) => (errnoNames[String(code)] || [null, 'Unknown system error ' + code])[1]);
    add('getSystemErrorMap', () => new Map(Object.entries(errnoNames).map(([k, v]) => [Number(k), v])));
    if (u.MIMEType === undefined) {
      class MIMEParams {
        #map = new Map();
        constructor(text) {
          for (const part of String(text || '').split(';')) {
            const [k, ...rest] = part.split('=');
            const key = k.trim().toLowerCase();
            if (!key) continue;
            let v = rest.join('=').trim();
            if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
            if (!this.#map.has(key)) this.#map.set(key, v);
          }
        }
        get(name) { return this.#map.has(name) ? this.#map.get(name) : null; }
        has(name) { return this.#map.has(name); }
        set(name, value) { this.#map.set(String(name).toLowerCase(), String(value)); }
        delete(name) { this.#map.delete(name); }
        entries() { return this.#map.entries(); }
        keys() { return this.#map.keys(); }
        values() { return this.#map.values(); }
        [Symbol.iterator]() { return this.#map.entries(); }
        toString() { return [...this.#map].map(([k, v]) => (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(v) ? k + '=' + v : k + '="' + v.replace(/["\\]/g, '\\$&') + '"')).join(';'); }
        toJSON() { return this.toString(); }
      }
      class MIMEType {
        constructor(input) {
          const text = String(input).trim();
          const semicolon = text.indexOf(';');
          const essence = (semicolon < 0 ? text : text.slice(0, semicolon)).trim().toLowerCase();
          const slash = essence.indexOf('/');
          if (slash <= 0 || slash === essence.length - 1) throw new TypeError('The MIME syntax for a type in "' + input + '" is invalid');
          this.type = essence.slice(0, slash);
          this.subtype = essence.slice(slash + 1);
          this.params = new MIMEParams(semicolon < 0 ? '' : text.slice(semicolon + 1));
        }
        get essence() { return this.type + '/' + this.subtype; }
        toString() { const p = this.params.toString(); return this.essence + (p ? ';' + p : ''); }
        toJSON() { return this.toString(); }
      }
      u.MIMEParams = MIMEParams;
      u.MIMEType = MIMEType;
    }
  });

  augment('stream', (s, add) => {
    add('destroy', (stream, error) => { if (stream && typeof stream.destroy === 'function') stream.destroy(error); return stream; });
    add('isDisturbed', (stream) => !!(stream && (stream.readableDidRead || stream.readableAborted)));
    add('getDefaultHighWaterMark', (objectMode) => (objectMode ? 16 : 65536));
    add('setDefaultHighWaterMark', () => {});
    add('compose', syncFence('stream.compose'));
    add('duplexPair', syncFence('stream.duplexPair'));
    add('_isUint8Array', (v) => v instanceof Uint8Array);
    add('_isArrayBufferView', (v) => ArrayBuffer.isView(v));
    add('_uint8ArrayToBuffer', (v) => (globalThis.Buffer ? globalThis.Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v));
  });

  augment('fs', (fs, add) => {
    for (const name of ['close', 'write', 'writev', 'readv', 'link', 'symlink', 'truncate', 'ftruncate', 'cp', 'chown', 'lchown', 'fchown', 'fchmod', 'lchmod', 'fsync', 'fdatasync', 'fstat', 'utimes', 'futimes', 'lutimes', 'opendir', 'glob', 'statfs']) {
      add(name, cbFence('fs.' + name));
    }
    for (const name of ['linkSync', 'symlinkSync', 'truncateSync', 'ftruncateSync', 'cpSync', 'chownSync', 'lchownSync', 'fchownSync', 'fchmodSync', 'lchmodSync', 'fsyncSync', 'fdatasyncSync', 'utimesSync', 'futimesSync', 'lutimesSync', 'opendirSync', 'globSync', 'statfsSync', 'writevSync', 'readvSync', 'openAsBlob', 'mkdtempDisposableSync']) {
      add(name, syncFence('fs.' + name));
    }
    if (fs.ReadStream === undefined) {
      class ReadStream { constructor() { throw notSupported('fs.ReadStream'); } }
      class WriteStream { constructor() { throw notSupported('fs.WriteStream'); } }
      class Dir { constructor() { throw notSupported('fs.Dir'); } }
      fs.ReadStream = ReadStream; fs.WriteStream = WriteStream; fs.Dir = Dir;
      fs.FileReadStream = ReadStream; fs.FileWriteStream = WriteStream;
    }
    add('_toUnixTimestamp', (time) => (typeof time === 'number' ? time : time instanceof Date ? time.getTime() / 1000 : Number(time)));
  });
  augment('fs/promises', (fsp, add) => {
    for (const name of ['link', 'symlink', 'truncate', 'cp', 'chown', 'lchown', 'lchmod', 'utimes', 'lutimes', 'opendir', 'glob', 'statfs', 'watch', 'mkdtempDisposable']) {
      add(name, promiseFence('fs.promises.' + name));
    }
  });

  augment('http', (http, add) => {
    add('maxHeaderSize', 16384);
    add('WebSocket', globalThis.WebSocket);
    add('CloseEvent', globalThis.CloseEvent);
    add('MessageEvent', globalThis.MessageEvent);
    add('setMaxIdleHTTPParsers', () => {});
    add('setGlobalProxyFromEnv', () => {});
    add('validateHeaderName', (name) => {
      if (typeof name !== 'string' || !/^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/.test(name)) {
        const e = new TypeError('Header name must be a valid HTTP token ["' + name + '"]'); e.code = 'ERR_INVALID_HTTP_TOKEN'; throw e;
      }
    });
    add('validateHeaderValue', (name, value) => {
      if (value === undefined) { const e = new TypeError('Invalid value "undefined" for header "' + name + '"'); e.code = 'ERR_HTTP_INVALID_HEADER_VALUE'; throw e; }
      if (/[^\t\x20-\x7e\x80-\xff]/.test(String(value))) { const e = new TypeError('Invalid character in header content ["' + name + '"]'); e.code = 'ERR_INVALID_CHAR'; throw e; }
    });
  });

  augment('module', (m, add) => {
    add('constants', { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } });
    add('globalPaths', []);
    add('findPackageJSON', syncFence('module.findPackageJSON'));
    add('enableCompileCache', () => ({ status: 3 }));
    add('flushCompileCache', () => {});
    add('getCompileCacheDir', () => undefined);
    add('getSourceMapsSupport', () => ({ enabled: false, nodeModules: false, generatedCode: false }));
    add('setSourceMapsSupport', () => {});
    add('stripTypeScriptTypes', syncFence('module.stripTypeScriptTypes'));
    add('registerHooks', () => ({ deregister() {} }));
    add('runMain', syncFence('module.runMain'));
    if (m.Module === undefined) {
      class Module {
        constructor(id = '', parent) { this.id = id; this.parent = parent || null; this.exports = {}; this.filename = null; this.loaded = false; this.children = []; this.paths = []; }
        require(spec) { return builtins.module().createRequire(this.filename || '/')(spec); }
        static _resolveFilename(request) { throw notSupported('Module._resolveFilename (' + request + ')'); }
        static _load(request) { throw notSupported('Module._load (' + request + ')'); }
        static _nodeModulePaths() { return []; }
        static _findPath() { return false; }
        static _initPaths() {}
        static _preloadModules() {}
      }
      Module._cache = Object.create(null);
      Module._pathCache = Object.create(null);
      Module._extensions = { '.js': syncFence('Module._extensions[".js"]'), '.json': syncFence('Module._extensions[".json"]'), '.node': syncFence('Module._extensions[".node"]') };
      Module.builtinModules = m.builtinModules;
      Module.createRequire = m.createRequire;
      Module.isBuiltin = m.isBuiltin;
      Module.register = m.register;
      Module.Module = Module;
      m.Module = Module;
    }
    if (m.SourceMap === undefined) {
      class SourceMap {
        constructor(payload) { this.payload = payload; }
        findEntry() { return {}; }
        findOrigin() { return {}; }
      }
      m.SourceMap = SourceMap;
    }
  });

  augment('perf_hooks', (p, add) => {
    if (globalThis.performance) {
      for (const key of ['now', 'timeOrigin', 'mark', 'measure', 'getEntries', 'getEntriesByName', 'getEntriesByType', 'clearMarks', 'clearMeasures', 'timerify', 'eventLoopUtilization', 'toJSON']) {
        if (p.performance && p.performance[key] === undefined && globalThis.performance[key] !== undefined) {
          p.performance[key] = typeof globalThis.performance[key] === 'function' ? globalThis.performance[key].bind(globalThis.performance) : globalThis.performance[key];
        }
      }
    }
    class PerformanceEntry { constructor(name, entryType, startTime, duration) { this.name = name; this.entryType = entryType; this.startTime = startTime; this.duration = duration; } toJSON() { return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration }; } }
    class PerformanceMark extends PerformanceEntry { constructor(name, options) { super(name, 'mark', (p.performance ? p.performance.now() : 0), 0); this.detail = options && options.detail !== undefined ? options.detail : null; } }
    class PerformanceMeasure extends PerformanceEntry { constructor(name, start, duration, detail) { super(name, 'measure', start, duration); this.detail = detail === undefined ? null : detail; } }
    class PerformanceObserverEntryList { constructor(entries) { this._entries = entries || []; } getEntries() { return [...this._entries]; } getEntriesByName(n, t) { return this._entries.filter((e) => e.name === n && (t === undefined || e.entryType === t)); } getEntriesByType(t) { return this._entries.filter((e) => e.entryType === t); } }
    class PerformanceResourceTiming extends PerformanceEntry {}
    class Performance { constructor() { throw new TypeError('Illegal constructor'); } }
    add('PerformanceEntry', PerformanceEntry);
    add('PerformanceMark', PerformanceMark);
    add('PerformanceMeasure', PerformanceMeasure);
    add('PerformanceObserverEntryList', PerformanceObserverEntryList);
    add('PerformanceResourceTiming', PerformanceResourceTiming);
    add('Performance', Performance);
    add('eventLoopUtilization', () => ({ idle: 0, active: 0, utilization: 0 }));
    add('timerify', (fn) => fn);
    add('createHistogram', () => {
      const samples = [];
      const sorted = () => [...samples].sort((a, b) => a - b);
      return {
        record(v) { samples.push(Number(v)); },
        recordDelta() {},
        reset() { samples.length = 0; },
        get count() { return samples.length; },
        get min() { return samples.length ? Math.min(...samples) : 9223372036854776000; },
        get max() { return samples.length ? Math.max(...samples) : 0; },
        get mean() { return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : NaN; },
        get stddev() { if (!samples.length) return NaN; const m = samples.reduce((a, b) => a + b, 0) / samples.length; return Math.sqrt(samples.reduce((a, b) => a + (b - m) ** 2, 0) / samples.length); },
        get exceeds() { return 0; },
        percentile(p) { const s = sorted(); if (!s.length) return 0; return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; },
        get percentiles() { return new Map(); },
        toJSON() { return { count: samples.length }; },
      };
    });
  });

  augment('child_process', (cp, add) => {
    if (cp.ChildProcess === undefined) {
      const EventEmitter = builtins.events().EventEmitter || builtins.events();
      class ChildProcess extends EventEmitter {
        constructor() { super(); this.pid = undefined; this.exitCode = null; this.signalCode = null; this.killed = false; this.connected = false; this.stdin = null; this.stdout = null; this.stderr = null; this.stdio = [null, null, null]; }
        kill() { return false; }
        ref() {} unref() {} disconnect() {} send() { return false; }
        spawn() { throw notSupported('ChildProcess.spawn'); }
      }
      cp.ChildProcess = ChildProcess;
    }
  });

  augment('timers', (t, add) => { add('promises', builtins['timers/promises'] ? builtins['timers/promises']() : undefined); });
  augment('readline', (r, add) => { add('promises', builtins['readline/promises'] ? builtins['readline/promises']() : { createInterface: syncFence('readline.promises.createInterface') }); });

  augment('zlib', (z, add) => {
    add('codes', { Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6, '0': 'Z_OK', '1': 'Z_STREAM_END', '2': 'Z_NEED_DICT', '-1': 'Z_ERRNO', '-2': 'Z_STREAM_ERROR', '-3': 'Z_DATA_ERROR', '-4': 'Z_MEM_ERROR', '-5': 'Z_BUF_ERROR', '-6': 'Z_VERSION_ERROR' });
    let table = null;
    add('crc32', (data, value = 0) => {
      if (table === null) { table = new Int32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } }
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      let crc = (value ^ 0xffffffff) >>> 0;
      for (let i = 0; i < bytes.length; i += 1) crc = (table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
      return (crc ^ 0xffffffff) >>> 0;
    });
    for (const name of ['brotliCompress', 'brotliDecompress', 'zstdCompress', 'zstdDecompress']) add(name, cbFence('zlib.' + name));
    for (const name of ['zstdCompressSync', 'zstdDecompressSync', 'createZstdCompress', 'createZstdDecompress']) add(name, syncFence('zlib.' + name));
    if (z.ZstdCompress === undefined) { class ZstdCompress { constructor() { throw notSupported('zlib.ZstdCompress'); } } class ZstdDecompress { constructor() { throw notSupported('zlib.ZstdDecompress'); } } z.ZstdCompress = ZstdCompress; z.ZstdDecompress = ZstdDecompress; }
  });

  augment('net', (n, add) => {
    add('Stream', n.Socket);
    if (n.BlockList === undefined) {
      class BlockList { constructor() { this.rules = []; } addAddress() {} addRange() {} addSubnet() {} check() { return false; } }
      class SocketAddress { constructor(options = {}) { this.address = options.address || '127.0.0.1'; this.family = options.family || 'ipv4'; this.port = options.port || 0; this.flowlabel = options.flowlabel || 0; } static parse(input) { const m = /^(.*?):(\d+)$/.exec(String(input)); return m ? new SocketAddress({ address: m[1], port: Number(m[2]) }) : undefined; } }
      n.BlockList = BlockList; n.SocketAddress = SocketAddress;
    }
    add('getDefaultAutoSelectFamily', () => true);
    add('setDefaultAutoSelectFamily', () => {});
    add('getDefaultAutoSelectFamilyAttemptTimeout', () => 250);
    add('setDefaultAutoSelectFamilyAttemptTimeout', () => {});
  });

  augment('tls', (t, add) => {
    add('CLIENT_RENEG_LIMIT', 3); add('CLIENT_RENEG_WINDOW', 600);
    add('DEFAULT_CIPHERS', 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA');
    add('DEFAULT_ECDH_CURVE', 'auto'); add('DEFAULT_MAX_VERSION', 'TLSv1.3'); add('DEFAULT_MIN_VERSION', 'TLSv1.2');
    add('getCiphers', () => []);
    add('getCACertificates', () => []);
    add('setDefaultCACertificates', () => {});
    add('getCertificateCompressionAlgorithms', () => []);
    add('checkServerIdentity', () => undefined);
    add('convertALPNProtocols', (protocols, out) => { if (out && Array.isArray(protocols)) out.ALPNProtocols = protocols; });
    if (t.SecureContext === undefined) { class SecureContext { constructor() { this.context = {}; } } t.SecureContext = SecureContext; }
    if (t.Server === undefined) { class Server { constructor() { throw notSupported('tls.Server'); } } t.Server = Server; }
  });

  augment('console', (c, add) => {
    add('context', () => c);
    add('createTask', () => ({ run: (fn) => fn() }));
    for (const name of ['profile', 'profileEnd', 'timeStamp', 'dirxml', 'groupCollapsed', 'timeLog']) add(name, () => {});
  });

  augment('crypto', (c, add) => {
    add('randomUUIDv7', () => {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      const ms = Date.now();
      bytes[0] = (ms / 2 ** 40) & 0xff; bytes[1] = (ms / 2 ** 32) & 0xff; bytes[2] = (ms / 2 ** 24) & 0xff; bytes[3] = (ms / 2 ** 16) & 0xff; bytes[4] = (ms / 2 ** 8) & 0xff; bytes[5] = ms & 0xff;
      bytes[6] = (bytes[6] & 0x0f) | 0x70; bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    });
    add('getCipherInfo', () => undefined);
    for (const name of ['Sign', 'Verify', 'Cipheriv', 'Decipheriv', 'DiffieHellman', 'DiffieHellmanGroup', 'ECDH']) {
      if (c[name] === undefined) { const cls = { [name]: class { constructor() { throw notSupported('crypto.' + name); } } }[name]; c[name] = cls; }
    }
    add('createDiffieHellmanGroup', syncFence('crypto.createDiffieHellmanGroup'));
    add('getDiffieHellman', syncFence('crypto.getDiffieHellman'));
  });

  augment('url', (u, add) => {
    add('fileURLToPathBuffer', (url) => (globalThis.Buffer ? globalThis.Buffer.from(u.fileURLToPath(url)) : new TextEncoder().encode(u.fileURLToPath(url))));
    add('resolveObject', (from, to) => u.parse(u.resolve(typeof from === 'string' ? from : u.format(from), to)));
    if (u.Url === undefined) { class Url { constructor() { this.protocol = null; this.slashes = null; this.auth = null; this.host = null; this.port = null; this.hostname = null; this.hash = null; this.search = null; this.query = null; this.pathname = null; this.path = null; this.href = null; } parse(input) { return Object.assign(this, u.parse(input)); } format() { return u.format(this); } resolve(to) { return u.resolve(this.href || '', to); } } u.Url = Url; }
  });

  augment('assert', (a, add) => {
    add('partialDeepStrictEqual', (actual, expected, message) => {
      const covers = (x, y) => {
        if (Object.is(x, y)) return true;
        if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
        if (Array.isArray(y)) return Array.isArray(x) && y.every((v, i) => covers(x[i], v));
        return Object.keys(y).every((k) => covers(x[k], y[k]));
      };
      if (!covers(actual, expected)) {
        const e = new (a.AssertionError || Error)(message || 'Expected values to be partially and strictly equal');
        e.code = 'ERR_ASSERTION'; throw e;
      }
    });
  });

  augment('process', (p, add) => {
    add('arch', typeof host.arch === 'function' ? host.arch() : 'x64');
    add('features', { inspector: false, debug: false, uv: true, ipv6: true, tls_alpn: true, tls_sni: true, tls_ocsp: false, tls: true, cached_builtins: true, require_module: true, typescript: false });
    add('report', { compact: false, directory: '', filename: '', reportOnFatalError: false, reportOnSignal: false, reportOnUncaughtException: false, signal: 'SIGUSR2', getReport: () => ({}), writeReport: () => '' });
    add('ref', () => {}); add('unref', () => {});
    add('domain', null);
    add('debugPort', 9229);
    add('availableMemory', () => 0);
    add('constrainedMemory', () => 0);
    add('cpuUsage', () => ({ user: 0, system: 0 }));
    add('getBuiltinModule', (name) => {
      const bare = String(name).startsWith('node:') ? String(name).slice(5) : String(name);
      return typeof builtins[bare] === 'function' ? builtins[bare]() : undefined;
    });
    add('getActiveResourcesInfo', () => []);
    add('setSourceMapsEnabled', () => {});
    add('binding', syncFence('process.binding'));
    add('dlopen', syncFence('process.dlopen'));
    add('execve', syncFence('process.execve'));
    add('chdir', typeof p.chdir === 'function' ? p.chdir : syncFence('process.chdir'));
    add('abort', () => { throw notSupported('process.abort'); });
    add('finalization', { register() {}, registerBeforeExit() {}, unregister() {} });
  });
