    /* node:http/node:https — the CLIENT slice over the socket units
     * (scr_net_island.c's host functions; registered only when that
     * bridge is linked, so bridge-less builds keep the does-not-provide
     * refusal). request/get drive real sockets: scr_net + scr_tls +
     * scr_http's client parser — node:http semantics (no redirects, no
     * decompression, Node's error messages off the net layer). The
     * exchange starts LAZILY at first write/end/flushHeaders so
     * setHeader-after-construction works (divergence: Node dials at
     * construction; same events, later dial). Servers and raw sockets
     * are loud fences — node:net/node:tls below load (eval-time requires
     * succeed, Node's shape) and fence at the call. */
  if (host.httpStart) {
    const makeHttpMod = (secure) => {
      const { EventEmitter } = builtins.events();
      const { Buffer } = builtins.buffer();
      const toU8 = (chunk, enc) => {
        if (typeof chunk === 'string') return Buffer.from(chunk, enc || 'utf8');
        if (chunk instanceof Uint8Array) return chunk;
        const e = new TypeError('The "chunk" argument must be of type string or an instance of Buffer or Uint8Array');
        e.code = 'ERR_INVALID_ARG_TYPE';
        throw e;
      };
    /* Node's IncomingMessage header fold: set-cookie collects an array,
     * repeats of everything else join ', ' (approximation of Node's
     * singleton-discard list — divergence noted in the lane report). */
      const foldHeaders = (raw) => {
        const h = {};
        for (let i = 0; i + 1 < raw.length; i += 2) {
          const k = raw[i].toLowerCase();
          const v = raw[i + 1];
          if (k === 'set-cookie') { if (h[k] === undefined) h[k] = []; h[k].push(v); }
          else if (h[k] === undefined) h[k] = v;
          else h[k] += ', ' + v;
        }
        return h;
      };
      class Agent { constructor(options) { this.options = options || {}; } destroy() {} }
      class IncomingMessage extends EventEmitter {
        constructor(req, status, statusText, raw) {
          super();
          this.req = req;
          this.statusCode = status;
          this.statusMessage = statusText;
          this.rawHeaders = raw;
          this.headers = foldHeaders(raw);
          this.httpVersion = '1.1';
          this.httpVersionMajor = 1;
          this.httpVersionMinor = 1;
          this.complete = false;
          this.aborted = false;
          this.readableEnded = false;
          this.readable = true;
          this.destroyed = false;
          this._enc = null;
          this._pipes = undefined;
    /* Server-side requests arrive with no ClientRequest behind them: the
     * exchange id is the handle destroy() reaches through instead. */
          this._scrExch = null;
        }
        setEncoding(enc) { this._enc = enc; return this; }
        resume() { return this; }
        pause() { return this; }
        isPaused() { return false; }
        read() { return null; }
    /* The Readable plumbing express's finalhandler reaches for on the
     * 404 path (req.unpipe() then onFinished(req, write)) — and that any
     * body-reading middleware pipes with. Both are the ordinary
     * data/end relay, not a second buffering layer. */
        pipe(dest, opts) {
          const self = this;
          const endDest = !(opts && opts.end === false);
          const onData = (chunk) => { dest.write(chunk); };
          const onEnd = () => { self.removeListener('data', onData); if (endDest) dest.end(); };
          this.on('data', onData);
          this.once('end', onEnd);
          if (this._pipes === undefined) this._pipes = [];
          this._pipes.push([dest, onData, onEnd]);
          dest.emit('pipe', this);
          return dest;
        }
        unpipe(dest) {
          if (this._pipes === undefined) return this;
          const keep = [];
          for (const p of this._pipes) {
            if (dest === undefined || p[0] === dest) {
              this.removeListener('data', p[1]);
              this.removeListener('end', p[2]);
              if (p[0] && typeof p[0].emit === 'function') p[0].emit('unpipe', this);
            } else keep.push(p);
          }
          this._pipes = keep;
          return this;
        }
        destroy() {
          this.destroyed = true;
          this.readable = false;
          if (this._scrExch !== null) host.srvResDestroy(this._scrExch);
          else if (this.req !== null && this.req !== undefined) this.req.destroy();
          return this;
        }
      }
    /* OutgoingMessage / ServerResponse — the WRITE side's shape. express
     * builds its response object as Object.create(http.ServerResponse.
     * prototype) at module load and composes its own methods on top, so
     * the prototype chain and the method surface must EXIST even though
     * the island never serves a socket itself (real serving is the
     * compiled static side's; a request-time res arrives from there).
     * Everything here is honest in-memory bookkeeping — the header store,
     * the status line, the output buffer — which is exactly what Node's
     * own OutgoingMessage does for a message with no socket assigned
     * (_writeRaw falls back to outputData). No fence is needed because no
     * I/O is attempted: a detached message just accumulates. */
      const tokenRe = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
      const checkName = (name) => {
        if (typeof name !== 'string' || !tokenRe.test(name)) {
          const e = new TypeError('Header name must be a valid HTTP token [\"' + name + '\"]');
          e.code = 'ERR_INVALID_HTTP_TOKEN';
          throw e;
        }
      };
      const sentError = (verb) => {
        const e = new Error('Cannot ' + verb + ' headers after they are sent to the client');
        e.code = 'ERR_HTTP_HEADERS_SENT';
        return e;
      };
      class OutgoingMessage extends EventEmitter {
        constructor() {
          super();
          this.outputData = [];
          this.outputSize = 0;
          this.writable = true;
          this.destroyed = false;
          this.chunkedEncoding = false;
          this.shouldKeepAlive = true;
          this.maxRequestsOnConnectionReached = false;
          this.useChunkedEncodingByDefault = true;
          this.sendDate = false;
          this.finished = false;
          this.strictContentLength = false;
          this.socket = null;
          this._contentLength = null;
          this._hasBody = true;
          this._trailer = '';
          this._header = null;
          this._headerSent = false;
          this._outHeaders = null;
          this._writableEnded = false;
          this._writableFinished = false;
    /* The native sink: null for a detached message (the buffering shape
     * above), otherwise the compiled runtime's exchange id. With one set,
     * the header block and every body chunk go STRAIGHT to scr_http.c —
     * so the wire bytes a served response produces are the static lane's,
     * not a second serializer's. _scrWireExtra carries the writeHead-only
     * headers, which Node puts on the wire without making them readable. */
          this._scrSink = null;
          this._scrHeadSent = false;
          this._scrWireExtra = null;
        }
        _scrFlushHead() {
          if (this._scrSink === null || this._scrHeadSent) return;
          this._scrHeadSent = true;
          const flat = [];
          if (this._outHeaders !== null) {
            for (const k of Object.keys(this._outHeaders)) {
              const ent = this._outHeaders[k];
              if (Array.isArray(ent[1])) { for (const one of ent[1]) flat.push(ent[0], String(one)); }
              else flat.push(ent[0], String(ent[1]));
            }
          }
          if (this._scrWireExtra !== null) { for (const x of this._scrWireExtra) flat.push(x); }
          const msg = this.statusMessage === undefined ? null : String(this.statusMessage);
          host.srvResHead(this._scrSink, this.statusCode, msg, flat);
        }
        get headersSent() { return !!this._header; }
        get writableEnded() { return this._writableEnded; }
        get writableFinished() { return this._writableFinished; }
        get connection() { return this.socket; }
        set connection(v) { this.socket = v; }
        setHeader(name, value) {
          if (this._header) throw sentError('set');
          checkName(name);
          if (value === undefined) {
            const e = new TypeError('Invalid value \"undefined\" for header \"' + name + '\"');
            e.code = 'ERR_HTTP_INVALID_HEADER_VALUE';
            throw e;
          }
          if (this._outHeaders === null) this._outHeaders = Object.create(null);
          this._outHeaders[name.toLowerCase()] = [name, value];
          return this;
        }
        appendHeader(name, value) {
          if (this._header) throw sentError('append');
          checkName(name);
          const key = name.toLowerCase();
          const cur = this._outHeaders === null ? undefined : this._outHeaders[key];
          if (cur === undefined) return this.setHeader(name, value);
          const prev = Array.isArray(cur[1]) ? cur[1] : [cur[1]];
          this._outHeaders[key] = [cur[0], prev.concat(value)];
          return this;
        }
        getHeader(name) {
          checkName(name);
          if (this._outHeaders === null) return undefined;
          const e = this._outHeaders[String(name).toLowerCase()];
          return e === undefined ? undefined : e[1];
        }
        getHeaderNames() { return this._outHeaders === null ? [] : Object.keys(this._outHeaders); }
        getRawHeaderNames() {
          if (this._outHeaders === null) return [];
          return Object.keys(this._outHeaders).map((k) => this._outHeaders[k][0]);
        }
        getHeaders() {
          const out = Object.create(null);
          if (this._outHeaders !== null) {
            for (const k of Object.keys(this._outHeaders)) out[k] = this._outHeaders[k][1];
          }
          return out;
        }
        hasHeader(name) {
          checkName(name);
          return this._outHeaders !== null && this._outHeaders[String(name).toLowerCase()] !== undefined;
        }
        removeHeader(name) {
          if (this._header) throw sentError('remove');
          checkName(name);
          if (this._outHeaders !== null) delete this._outHeaders[String(name).toLowerCase()];
        }
    /* Node's base class refuses: only the concrete subclasses know how to
     * render a first line (ServerResponse's writeHead does). */
        _implicitHeader() {
          const e = new Error('The _implicitHeader() method is not implemented');
          e.code = 'ERR_METHOD_NOT_IMPLEMENTED';
          throw e;
        }
        _endedError() {
          const e = new Error('write after end');
          e.code = 'ERR_STREAM_WRITE_AFTER_END';
          return e;
        }
        write(chunk, enc, cb) {
          if (typeof enc === 'function') { cb = enc; enc = undefined; }
          if (this.finished) {
            const err = this._endedError();
            if (cb) queueMicrotask(() => cb(err));
            else { const self = this; queueMicrotask(() => self.emit('error', err)); }
            return false;
          }
          if (!this._header) this._implicitHeader();
    /* outputData carries Node's entry shape ({ data, encoding, callback })
     * but BODY writes only: Node's first entry is the serialized wire
     * header block, and serializing one is exactly the socket work this
     * shim does not do. Documented divergence — nothing but a test reads
     * this field, and the headers themselves stay readable through
     * getHeaders(). */
          if (this._hasBody && chunk !== undefined && chunk !== null && chunk !== '') {
            const u8 = toU8(chunk, enc);
            if (this._scrSink !== null) host.srvResWrite(this._scrSink, u8);
            else {
              this.outputData.push({ data: u8, encoding: enc === undefined ? 'buffer' : enc, callback: cb === undefined ? null : cb });
              this.outputSize += u8.length;
            }
          }
          if (cb) queueMicrotask(cb);
          return true;
        }
        end(chunk, enc, cb) {
          if (typeof chunk === 'function') { cb = chunk; chunk = undefined; enc = undefined; }
          else if (typeof enc === 'function') { cb = enc; enc = undefined; }
          if (this.finished) {
            if (cb) { const err = this._endedError(); queueMicrotask(() => cb(err)); }
            return this;
          }
    /* On the native sink the final chunk rides END, not a write: Node's
     * res.end(body) is ONE chunk on the wire (it matters under chunked
     * framing, where a split would show as two chunk headers). */
          if (this._scrSink !== null) {
            if (!this._header) this._implicitHeader();
            const tail = (this._hasBody && chunk !== undefined && chunk !== null && chunk !== '')
              ? toU8(chunk, enc) : null;
            host.srvResEnd(this._scrSink, tail);
          }
          else if (chunk !== undefined && chunk !== null) this.write(chunk, enc);
          else if (!this._header) this._implicitHeader();
          this.finished = true;
          this._writableEnded = true;
    /* Node's completion rides the SOCKET write callback: a message with
     * no socket assigned buffers into outputData and never reports
     * 'finish' (its end callback stays queued). Same here — the detached
     * message stays silent rather than inventing a completion. */
          if (this.socket !== null && this.socket !== undefined) {
            const self = this;
            queueMicrotask(() => {
              self._writableFinished = true;
              if (cb) cb();
              self.emit('finish');
            });
          }
          return this;
        }
        flushHeaders() { if (!this._header) this._implicitHeader(); this._headerSent = true; }
        addTrailers(_headers) {}
        cork() {}
        uncork() {}
        setTimeout(_ms, cb) { if (cb) this.once('timeout', cb); return this; }
        destroy(err) {
          if (this.destroyed) return this;
          this.destroyed = true;
          this.writable = false;
          if (err) { const self = this; queueMicrotask(() => self.emit('error', err)); }
          return this;
        }
        pipe() {
          const e = new Error('Cannot pipe, not readable');
          e.code = 'ERR_STREAM_CANNOT_PIPE';
          this.emit('error', e);
        }
      }
      class ServerResponse extends OutgoingMessage {
        constructor(req) {
          super();
          this.statusCode = 200;
          this.statusMessage = undefined;
          this.sendDate = true;
          this.req = req;
          this._sent100 = false;
          this._expect_continue = false;
          if (req !== undefined && req !== null) {
            if (req.method === 'HEAD') this._hasBody = false;
            if (req.httpVersionMajor === 1 && req.httpVersionMinor === 0) {
              this.useChunkedEncodingByDefault = req.method === 'PRI';
              this.shouldKeepAlive = false;
            }
          }
        }
        writeHead(statusCode, reason, obj) {
          const code = statusCode | 0;
          if (code < 100 || code > 999) {
            const e = new RangeError('Invalid status code: ' + statusCode);
            e.code = 'ERR_HTTP_INVALID_STATUS_CODE';
            throw e;
          }
          if (typeof reason === 'string') this.statusMessage = reason;
          else {
            if (obj === undefined) obj = reason;
            if (!this.statusMessage) this.statusMessage = STATUS_CODES[code] || 'unknown';
          }
          this.statusCode = code;
    /* Node's two writeHead cases: with a header store ALREADY open (the
     * progressive setHeader api), the argument merges into it; with none,
     * the argument goes STRAIGHT to the serialized block and never
     * becomes readable through getHeader — writeHead-only responses have
     * an empty store. Reproduced exactly, because express's error paths
     * read headers back after a writeHead. */
          if (obj !== undefined && obj !== null && this._outHeaders !== null) {
            if (Array.isArray(obj)) {
              if (obj.length && Array.isArray(obj[0])) { for (const p of obj) this.setHeader(p[0], p[1]); }
              else { for (let i = 0; i + 1 < obj.length; i += 2) this.setHeader(obj[i], obj[i + 1]); }
            } else {
              for (const k of Object.keys(obj)) { if (k) this.setHeader(k, obj[k]); }
            }
    /* The store-less case: these go on the WIRE but never become
     * readable (Node's rule, reproduced above). Collected here so a
     * served response still carries them. */
          } else if (obj !== undefined && obj !== null) {
            const extra = [];
            if (Array.isArray(obj)) {
              if (obj.length && Array.isArray(obj[0])) { for (const p of obj) extra.push(String(p[0]), String(p[1])); }
              else { for (let i = 0; i + 1 < obj.length; i += 2) extra.push(String(obj[i]), String(obj[i + 1])); }
            } else {
              for (const k of Object.keys(obj)) {
                if (!k) continue;
                const v = obj[k];
                if (Array.isArray(v)) { for (const one of v) extra.push(k, String(one)); }
                else extra.push(k, String(v));
              }
            }
            this._scrWireExtra = extra;
          }
          this._header = 'HTTP/1.1 ' + code + ' ' + this.statusMessage + '\r\n';
          this._scrFlushHead();
          return this;
        }
        _implicitHeader() { this.writeHead(this.statusCode); }
        assignSocket(socket) { this.socket = socket; this.emit('socket', socket); }
        detachSocket(_socket) { this.socket = null; }
        writeContinue(cb) { this._sent100 = true; if (cb) queueMicrotask(cb); }
        writeProcessing(cb) { if (cb) queueMicrotask(cb); }
        writeEarlyHints(_hints, cb) { if (cb) queueMicrotask(cb); }
      }
      class ClientRequest extends EventEmitter {
        constructor(options, cb) {
          super();
          if (cb) this.once('response', cb);
          this._o = options;
          this._headers = Object.create(null);
          this._id = 0;
          this._started = false;
          this._timeoutMs = options.timeout !== undefined ? Number(options.timeout) : 0;
          this.destroyed = false;
          this.writableEnded = false;
          this.res = null;
          const h = options.headers || {};
          for (const k of Object.keys(h)) { if (h[k] !== undefined) this.setHeader(k, h[k]); }
        }
        setHeader(name, value) { this._headers[String(name).toLowerCase()] = { name: String(name), value }; return this; }
        getHeader(name) { const e = this._headers[String(name).toLowerCase()]; return e === undefined ? undefined : e.value; }
        removeHeader(name) { delete this._headers[String(name).toLowerCase()]; }
        setTimeout(ms, cb) {
          if (cb) this.once('timeout', cb);
          this._timeoutMs = Number(ms) || 0;
          if (this._started && this._id) host.httpSetTimeout(this._id, this._timeoutMs);
          return this;
        }
        _start() {
          if (this._started || this.destroyed) return;
          this._started = true;
          const o = this._o;
          const self = this;
          const flat = [];
          for (const k of Object.keys(this._headers)) {
            const e = this._headers[k];
            if (Array.isArray(e.value)) { for (const v of e.value) flat.push(e.name, String(v)); }
            else flat.push(e.name, String(e.value));
          }
          let hostn = o.hostname !== undefined && o.hostname !== null && o.hostname !== '' ? o.hostname : (o.host || 'localhost');
          hostn = String(hostn);
          let port = o.port !== undefined && o.port !== null && o.port !== '' ? Number(o.port) : (secure ? 443 : 80);
          if ((o.hostname === undefined || o.hostname === null || o.hostname === '') && hostn.lastIndexOf(':') > hostn.lastIndexOf(']')) {
            const i = hostn.lastIndexOf(':');
            if (o.port === undefined || o.port === null || o.port === '') port = Number(hostn.slice(i + 1)) || port;
            hostn = hostn.slice(0, i);
          }
          if (hostn.startsWith('[') && hostn.endsWith(']')) hostn = hostn.slice(1, -1);
          this._id = host.httpStart(secure, hostn, port, String(o.path || '/'), String(o.method || 'GET').toUpperCase(), this._timeoutMs, flat, {
            onResponse(status, statusText, raw) {
              const res = new IncomingMessage(self, status, statusText, raw);
              self.res = res;
              self.emit('response', res);
            },
            onData(u8) {
              const res = self.res;
              if (res === null) return;
              const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.length);
              res.emit('data', res._enc ? buf.toString(res._enc) : buf);
            },
            onEnd() { const res = self.res; if (res !== null) { res.complete = true; res.emit('end'); } },
            onError(msg) {
              const e = new Error(msg);
              const m = /^(connect|getaddrinfo) (E[A-Z]+)/.exec(msg);
              if (m) { e.code = m[2]; e.syscall = m[1]; }
              else if (msg === 'socket hang up') e.code = 'ECONNRESET';
              self.emit('error', e);
            },
            onResError(msg) {
              const res = self.res;
              if (res !== null) { res.aborted = true; res.emit('error', new Error(msg)); }
            },
            onTimeout() { self.emit('timeout'); },
            onClose() { self.emit('close'); if (self.res !== null) self.res.emit('close'); },
          });
        }
        flushHeaders() { this._start(); }
        write(chunk, enc, cb) {
          if (typeof enc === 'function') { cb = enc; enc = undefined; }
          this._start();
          if (this._id && !this.writableEnded) host.httpWrite(this._id, toU8(chunk, enc));
          if (cb) queueMicrotask(cb);
          return true;
        }
        end(chunk, enc, cb) {
          if (typeof chunk === 'function') { cb = chunk; chunk = undefined; enc = undefined; }
          else if (typeof enc === 'function') { cb = enc; enc = undefined; }
          this._start();
          if (this._id && !this.writableEnded) {
            this.writableEnded = true;
            host.httpEnd(this._id, chunk === undefined || chunk === null ? undefined : toU8(chunk, enc));
          }
          if (cb) queueMicrotask(cb);
          return this;
        }
    /* Node's destroy() mid-flight lets the socket teardown speak: 'socket
     * hang up' then 'close' (the natural premature path — oracle-pinned);
     * a request destroyed before it ever started just closes. */
        destroy(_err) {
          if (this.destroyed) return this;
          this.destroyed = true;
          if (this._started && this._id) { host.httpDestroy(this._id); }
          else { const self = this; queueMicrotask(() => self.emit('close')); }
          return this;
        }
        abort() { this.destroy(); }
      }
    /* request(url|options[, options][, cb]) — Node's overloads: URL
     * fields merge under an options bag's explicit keys. */
      const normalize = (input, options, cb) => {
        if (typeof options === 'function') { cb = options; options = undefined; }
        let o = {};
        if (typeof input === 'string' || (input !== null && typeof input === 'object' && typeof input.href === 'string')) {
          const u = typeof input === 'string' ? new globalThis.URL(input) : input;
          if (secure && u.protocol === 'http:') throw new TypeError('Protocol "http:" not supported. Expected "https:"');
          if (!secure && u.protocol === 'https:') throw new TypeError('Protocol "https:" not supported. Expected "http:"');
          o.hostname = u.hostname;
          if (u.port) o.port = u.port;
          o.path = (u.pathname || '/') + (u.search || '');
        } else if (input !== null && typeof input === 'object') {
          o = Object.assign(o, input);
        }
        if (options !== undefined && options !== null) o = Object.assign(o, options);
        return [o, cb];
      };
      const request = (input, options, cb) => {
        const [o, cb2] = normalize(input, options, cb);
        return new ClientRequest(o, cb2);
      };
      const get = (input, options, cb) => { const r = request(input, options, cb); r.end(); return r; };
      const die = (what) => () => {
        throw new Error("node:http" + (secure ? 's' : '') + " '" + what + "' is not supported in the scriptc island yet (the client — request/get — is)");
      };
      const STATUS_CODES = { 100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints', 200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status', 208: 'Already Reported', 226: 'IM Used', 300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed', 418: "I'm a Teapot", 421: 'Misdirected Request', 422: 'Unprocessable Entity', 423: 'Locked', 424: 'Failed Dependency', 425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported', 506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected', 509: 'Bandwidth Limit Exceeded', 510: 'Not Extended', 511: 'Network Authentication Required' };
      const METHODS = ['ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL', 'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH', 'PURGE', 'PUT', 'QUERY', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE'];
    /* ── the SERVER side ────────────────────────────────────────────────
     * The island owns no listening socket. createServer here mints one in
     * the COMPILED runtime (scr_net_island.c's srvCreate → scr_http.c's
     * ordinary ScrNetServer, the very server the static lane serves
     * from), and every accepted request re-enters as an exchange id: the
     * request line/headers arrive as data, the response's header block and
     * body chunks leave through the same id. So express's app.listen()
     * inside the island is a real socket on a real port, and the bytes on
     * the wire are the static lane's oracle-pinned bytes rather than a
     * second serializer's guess.
     *
     * https servers stay fenced: a TLS listener needs cert/key material
     * plumbed through, which is a separate seam. */
      const canServe = !secure && typeof host.srvCreate === 'function';
      const scrSocketShim = (server, peer) => ({
        remoteAddress: peer, remotePort: undefined, localAddress: undefined,
        localPort: undefined, encrypted: false, destroyed: false,
        readable: true, writable: true, bytesRead: 0, bytesWritten: 0,
        address() { return server.address(); },
        setTimeout() { return this; }, setKeepAlive() { return this; },
        setNoDelay() { return this; }, ref() { return this; }, unref() { return this; },
        on() { return this; }, once() { return this; }, off() { return this; },
        addListener() { return this; }, removeListener() { return this; },
        emit() { return false; }, destroy() {}, end() {}, write() { return true; },
        cork() {}, uncork() {}, unpipe() { return this; }, pause() { return this; },
        resume() { return this; },
      });
      class Server extends EventEmitter {
        constructor(options, handler) {
          super();
          if (typeof options === 'function') { handler = options; options = undefined; }
          if (!canServe) die('createServer')();
          this.listening = false;
          this.maxHeadersCount = null;
          this.timeout = 0;
          this.keepAliveTimeout = 5000;
          this.headersTimeout = 60000;
          this.requestTimeout = 300000;
          this.maxRequestsPerSocket = 0;
          if (handler) this.on('request', handler);
          const self = this;
          this._scrId = host.srvCreate({
            onListening() { self.listening = true; self.emit('listening'); },
            onError(msg) {
              const e = new Error(msg);
              const m = /\b(E[A-Z]{3,})\b/.exec(msg);
              if (m) e.code = m[1];
              self.listening = false;
              self.emit('error', e);
            },
            onClose() { self.listening = false; self.emit('close'); },
            onRequest(id, method, url, raw, vmaj, vmin, peer) {
              const req = new IncomingMessage(null, undefined, undefined, raw);
              req.method = method;
              req.url = url;
              req.httpVersionMajor = vmaj;
              req.httpVersionMinor = vmin;
              req.httpVersion = vmaj + '.' + vmin;
              req._scrExch = id;
              const sock = scrSocketShim(self, peer);
              req.socket = sock;
              req.connection = sock;
              const res = new ServerResponse(req);
              res._scrSink = id;
              res.socket = sock;
              req.res = res;
              res.req = req;
              self.emit('request', req, res);
              return {
                onData(u8) {
                  req.emit('data', req._enc === null ? Buffer.from(u8) : Buffer.from(u8).toString(req._enc));
                },
                onEnd() { req.complete = true; req.readableEnded = true; req.readable = false; req.emit('end'); },
                onAborted() { req.aborted = true; req.emit('aborted'); },
                onClose() { req.emit('close'); res.emit('close'); },
              };
            },
          });
        }
    /* listen([port[, host[, backlog]]][, cb]) and listen(options[, cb]).
     * The bound port is the kernel's answer for port 0 and becomes
     * readable through address() once 'listening' has fired — Node's
     * ordering, because the emit rides the real bind. */
        listen(...args) {
          let port = 0;
          let hostname = null;
          let cb = null;
          let sawPort = false;
          for (const a of args) {
            if (typeof a === 'function') cb = a;
            else if (typeof a === 'number') { if (!sawPort) { port = a; sawPort = true; } }
            else if (typeof a === 'string') { if (!sawPort) { port = Number(a) || 0; sawPort = true; } else hostname = a; }
            else if (a !== null && typeof a === 'object') {
              if (a.port !== undefined) { port = Number(a.port) || 0; sawPort = true; }
              if (typeof a.host === 'string') hostname = a.host;
            }
          }
          if (args.length >= 2 && typeof args[0] === 'number' && typeof args[1] === 'string') hostname = args[1];
          if (cb) this.once('listening', cb);
          host.srvListen(this._scrId, port, hostname);
          return this;
        }
        address() {
          if (!this.listening) return null;
          const a = host.srvAddress(this._scrId);
          return { address: a[0], family: a[1], port: host.srvPort(this._scrId) };
        }
        close(cb) {
          if (cb) this.once('close', cb);
          host.srvClose(this._scrId);
          return this;
        }
        closeAllConnections() {}
        closeIdleConnections() {}
        setTimeout(ms, cb) { if (typeof ms === 'number') this.timeout = ms; if (cb) this.on('timeout', cb); return this; }
        getConnections(cb) { if (cb) queueMicrotask(() => cb(null, 0)); }
        ref() { return this; }
        unref() { return this; }
      }
      const createServer = (options, handler) => new Server(options, handler);
      const mod = {
        request, get, Agent, globalAgent: new Agent({ keepAlive: true }),
        ClientRequest, IncomingMessage, OutgoingMessage, ServerResponse,
        STATUS_CODES, METHODS,
        createServer, Server,
      };
      mod.default = mod;
      return mod;
    };
    builtins.http = memo(() => makeHttpMod(false));
    builtins.https = memo(() => makeHttpMod(true));
    /* node:net/node:tls — enough to LOAD (eval-time requires succeed,
     * Node's shape); the socket surfaces fence loudly at the call. isIP
     * and friends are real (address validation is common eval-adjacent
     * work). */
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
        let v4tail = false;
        const lastColon = s.lastIndexOf(':');
        if (s.indexOf('.') >= 0) {
          if (!isIPv4(s.slice(lastColon + 1))) return false;
          v4tail = true;
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
  }
