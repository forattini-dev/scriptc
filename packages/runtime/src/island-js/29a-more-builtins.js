  /* Builtins packages require at LOAD without using unless asked —
   * fastify's `require('node:http2')`, undici's dgram probe, cluster
   * and inspector guards. Each links with Node's shape and constants;
   * the operations fence at the call through the module's own error
   * channel. */
  const fenced = (what) => () => {
    const e = new Error(what + ' is not supported in the scriptc island yet');
    e.code = 'ERR_NOT_SUPPORTED';
    throw e;
  };
  const fencedClass = (what) => ({ [what]: class { constructor() { fenced(what)(); } } })[what];

  builtins.http2 = memo(() => {
    const EventEmitter = builtins.events().EventEmitter || builtins.events();
    const constants = {
      NGHTTP2_SESSION_SERVER: 0, NGHTTP2_SESSION_CLIENT: 1,
      NGHTTP2_STREAM_STATE_IDLE: 1, NGHTTP2_STREAM_STATE_OPEN: 2, NGHTTP2_STREAM_STATE_CLOSED: 7,
      NGHTTP2_NO_ERROR: 0, NGHTTP2_PROTOCOL_ERROR: 1, NGHTTP2_INTERNAL_ERROR: 2, NGHTTP2_FLOW_CONTROL_ERROR: 3,
      NGHTTP2_SETTINGS_TIMEOUT: 4, NGHTTP2_STREAM_CLOSED: 5, NGHTTP2_FRAME_SIZE_ERROR: 6, NGHTTP2_REFUSED_STREAM: 7,
      NGHTTP2_CANCEL: 8, NGHTTP2_COMPRESSION_ERROR: 9, NGHTTP2_CONNECT_ERROR: 10, NGHTTP2_ENHANCE_YOUR_CALM: 11,
      NGHTTP2_INADEQUATE_SECURITY: 12, NGHTTP2_HTTP_1_1_REQUIRED: 13,
      NGHTTP2_DEFAULT_WEIGHT: 16, NGHTTP2_FLAG_NONE: 0, NGHTTP2_FLAG_END_STREAM: 1, NGHTTP2_FLAG_END_HEADERS: 4,
      DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096, DEFAULT_SETTINGS_ENABLE_PUSH: 1, DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS: 4294967295,
      DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535, DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384, DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535,
      HTTP2_HEADER_STATUS: ':status', HTTP2_HEADER_METHOD: ':method', HTTP2_HEADER_AUTHORITY: ':authority', HTTP2_HEADER_SCHEME: ':scheme', HTTP2_HEADER_PATH: ':path',
      HTTP2_HEADER_CONTENT_TYPE: 'content-type', HTTP2_HEADER_CONTENT_LENGTH: 'content-length', HTTP2_HEADER_ACCEPT: 'accept', HTTP2_HEADER_AUTHORIZATION: 'authorization',
      HTTP2_HEADER_USER_AGENT: 'user-agent', HTTP2_HEADER_HOST: 'host', HTTP2_HEADER_COOKIE: 'cookie', HTTP2_HEADER_SET_COOKIE: 'set-cookie', HTTP2_HEADER_LOCATION: 'location',
      HTTP2_HEADER_CONTENT_ENCODING: 'content-encoding', HTTP2_HEADER_ACCEPT_ENCODING: 'accept-encoding', HTTP2_HEADER_TE: 'te', HTTP2_HEADER_CONNECTION: 'connection',
      HTTP2_HEADER_UPGRADE: 'upgrade', HTTP2_HEADER_KEEP_ALIVE: 'keep-alive', HTTP2_HEADER_PROXY_CONNECTION: 'proxy-connection', HTTP2_HEADER_TRANSFER_ENCODING: 'transfer-encoding',
      HTTP2_METHOD_GET: 'GET', HTTP2_METHOD_POST: 'POST', HTTP2_METHOD_PUT: 'PUT', HTTP2_METHOD_DELETE: 'DELETE', HTTP2_METHOD_HEAD: 'HEAD', HTTP2_METHOD_OPTIONS: 'OPTIONS', HTTP2_METHOD_CONNECT: 'CONNECT', HTTP2_METHOD_PATCH: 'PATCH',
      HTTP_STATUS_OK: 200, HTTP_STATUS_NOT_FOUND: 404, HTTP_STATUS_INTERNAL_SERVER_ERROR: 500, HTTP_STATUS_CONTINUE: 100, HTTP_STATUS_NO_CONTENT: 204, HTTP_STATUS_BAD_REQUEST: 400,
    };
    class Http2ServerRequest extends EventEmitter { constructor() { super(); fenced('http2.Http2ServerRequest')(); } }
    class Http2ServerResponse extends EventEmitter { constructor() { super(); fenced('http2.Http2ServerResponse')(); } }
    const m = {
      constants,
      createServer: fenced('http2.createServer'),
      createSecureServer: fenced('http2.createSecureServer'),
      connect: fenced('http2.connect'),
      getDefaultSettings: () => ({ headerTableSize: 4096, enablePush: true, initialWindowSize: 65535, maxFrameSize: 16384, maxConcurrentStreams: 4294967295, maxHeaderListSize: 65535, maxHeaderSize: 65535, enableConnectProtocol: false }),
      getPackedSettings: () => (globalThis.Buffer ? globalThis.Buffer.alloc(0) : new Uint8Array(0)),
      getUnpackedSettings: () => ({}),
      performServerHandshake: fenced('http2.performServerHandshake'),
      sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
      Http2ServerRequest, Http2ServerResponse,
      Http2Session: fencedClass('Http2Session'), ServerHttp2Session: fencedClass('ServerHttp2Session'), ClientHttp2Session: fencedClass('ClientHttp2Session'),
      Http2Stream: fencedClass('Http2Stream'), ServerHttp2Stream: fencedClass('ServerHttp2Stream'), ClientHttp2Stream: fencedClass('ClientHttp2Stream'),
      Http2Server: fencedClass('Http2Server'), Http2SecureServer: fencedClass('Http2SecureServer'),
    };
    m.default = m;
    return m;
  });

  builtins.dgram = memo(() => {
    const EventEmitter = builtins.events().EventEmitter || builtins.events();
    class Socket extends EventEmitter { constructor() { super(); fenced('dgram.Socket')(); } }
    const m = { createSocket: fenced('dgram.createSocket'), Socket };
    m.default = m;
    return m;
  });

  builtins.cluster = memo(() => {
    const EventEmitter = builtins.events().EventEmitter || builtins.events();
    const cluster = new EventEmitter();
    Object.assign(cluster, {
      isPrimary: true, isMaster: true, isWorker: false, workers: {}, worker: undefined,
      settings: {}, schedulingPolicy: 2, SCHED_NONE: 1, SCHED_RR: 2,
      setupPrimary: () => {}, setupMaster: () => {}, disconnect: (cb) => { if (typeof cb === 'function') queueMicrotask(cb); },
      fork: fenced('cluster.fork'),
      Worker: fencedClass('Worker'),
    });
    cluster.default = cluster;
    return cluster;
  });

  builtins.inspector = memo(() => {
    const EventEmitter = builtins.events().EventEmitter || builtins.events();
    class Session extends EventEmitter { connect() {} connectToMainThread() {} disconnect() {} post(method, params, cb) { const callback = typeof params === 'function' ? params : cb; if (typeof callback === 'function') queueMicrotask(() => callback(new Error('inspector is not available'))); } }
    const m = { open: () => {}, close: () => {}, url: () => undefined, waitForDebugger: () => {}, console: globalThis.console, Session, Network: { requestWillBeSent() {}, responseReceived() {}, loadingFinished() {}, loadingFailed() {} } };
    m.default = m;
    return m;
  });

  builtins.vm = memo(() => {
    class Script { constructor(code) { this.code = String(code); } runInThisContext() { return (0, eval)(this.code); } runInContext() { fenced('vm.Script.runInContext')(); } runInNewContext() { fenced('vm.Script.runInNewContext')(); } createCachedData() { return new Uint8Array(0); } }
    const m = {
      Script,
      createContext: (sandbox) => sandbox || {},
      isContext: () => false,
      runInThisContext: (code) => (0, eval)(String(code)),
      runInContext: fenced('vm.runInContext'),
      runInNewContext: fenced('vm.runInNewContext'),
      compileFunction: (code, params = []) => new Function(...params, String(code)),
      measureMemory: fenced('vm.measureMemory'),
      constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm_dynamic_import_main_context_default'), DONT_CONTEXTIFY: Symbol('vm_context_no_contextify') },
      SourceTextModule: fencedClass('SourceTextModule'), SyntheticModule: fencedClass('SyntheticModule'), Module: fencedClass('Module'),
    };
    m.default = m;
    return m;
  });

  builtins.sea = memo(() => { const m = { isSea: () => false, getAsset: fenced('sea.getAsset'), getAssetAsBlob: fenced('sea.getAssetAsBlob'), getRawAsset: fenced('sea.getRawAsset') }; m.default = m; return m; });
  builtins.trace_events = memo(() => { const m = { createTracing: () => ({ enable() {}, disable() {}, enabled: false, categories: '' }), getEnabledCategories: () => undefined }; m.default = m; return m; });
  builtins.repl = memo(() => { const m = { start: fenced('repl.start'), REPLServer: fencedClass('REPLServer'), Recoverable: class Recoverable extends SyntaxError {}, REPL_MODE_SLOPPY: Symbol('repl-sloppy'), REPL_MODE_STRICT: Symbol('repl-strict'), builtinModules: builtins.module().builtinModules }; m.default = m; return m; });
  builtins.wasi = memo(() => { const m = { WASI: fencedClass('WASI') }; m.default = m; return m; });
  builtins.test = memo(() => { const m = { test: fenced('node:test test'), describe: fenced('node:test describe'), it: fenced('node:test it'), before: fenced('node:test before'), after: fenced('node:test after'), beforeEach: fenced('node:test beforeEach'), afterEach: fenced('node:test afterEach'), mock: { fn: fenced('node:test mock.fn'), method: fenced('node:test mock.method'), reset: () => {}, restoreAll: () => {}, timers: {} }, run: fenced('node:test run'), skip: fenced('node:test skip'), todo: fenced('node:test todo'), only: fenced('node:test only'), suite: fenced('node:test suite'), snapshot: { setDefaultSnapshotSerializers() {}, setResolveSnapshotPath() {} }, assert: {} }; m.default = m.test; Object.assign(m.default, m); return m; });
  builtins.sqlite = memo(() => { const m = { DatabaseSync: fencedClass('DatabaseSync'), StatementSync: fencedClass('StatementSync'), Session: fencedClass('Session'), constants: { SQLITE_CHANGESET_OMIT: 0, SQLITE_CHANGESET_REPLACE: 1, SQLITE_CHANGESET_ABORT: 2, SQLITE_CHANGESET_DATA: 1, SQLITE_CHANGESET_NOTFOUND: 2, SQLITE_CHANGESET_CONFLICT: 3, SQLITE_CHANGESET_CONSTRAINT: 4, SQLITE_CHANGESET_FOREIGN_KEY: 5 }, backup: fenced('sqlite.backup') }; m.default = m; return m; });
