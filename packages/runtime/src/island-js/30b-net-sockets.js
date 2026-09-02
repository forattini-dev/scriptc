    /* node:net for real — Socket and Server over the compiled runtime's
     * own socket unit (island_host_net.rs's host functions).
     *
     * 30a-net-tls-load.js above leaves node:net LOADABLE but fenced at
     * every call, which is the honest answer for an island whose host has
     * no socket bridge. This part REPLACES that module when one is
     * linked: `host.netConnect` is the probe, so a bridge-less build
     * keeps the fence untouched and nothing here can silently half-work.
     *
     * The shim owns Node's stream semantics — pause/resume, the encoding,
     * allowHalfOpen, the timeout, the event ORDER (connect, ready, data…,
     * end, finish, close) — and the host owns the syscalls. Flow control
     * is the seam worth naming: a Node socket is PAUSED until something
     * reads it, so `.on('data')` and `.resume()` are what tell the host
     * to let the loop deliver, and the host re-pauses anything the shim
     * has not asked for. */
  if (host.netConnect) {
    const netFenced = builtins.net;
    builtins.net = memo(() => {
      const fenced = netFenced();
      const { EventEmitter } = builtins.events();
      const { Buffer } = builtins.buffer();
      const toU8 = (chunk, enc) => {
        if (typeof chunk === 'string') return Buffer.from(chunk, enc || 'utf8');
        if (chunk instanceof Uint8Array) return chunk;
        const e = new TypeError('The "chunk" argument must be of type string or an instance of Buffer or Uint8Array. Received ' + typeof chunk);
        e.code = 'ERR_INVALID_ARG_TYPE';
        throw e;
      };
    /* The runtime's socket errors carry Node's own wording — "connect
     * ECONNREFUSED 127.0.0.1:1", "listen EADDRINUSE" — so the errno name
     * and the syscall are recovered from the text rather than invented,
     * which is exactly what the http client shim does with the same
     * strings on the C island. */
      const netError = (msg) => {
        const e = new Error(msg);
        const m = /^(connect|listen|getaddrinfo|read|write) (E[A-Z]+)/.exec(msg);
        if (m) { e.code = m[2]; e.syscall = m[1]; }
        else { const g = /\b(E[A-Z]{3,})\b/.exec(msg); if (g) e.code = g[1]; }
        return e;
      };
      const later = (fn) => { globalThis.queueMicrotask(fn); };

      class Socket extends EventEmitter {
        constructor(options) {
          super();
          const o = options === null || options === undefined ? {} : options;
          this._id = 0;
          this._enc = null;
          this._reading = false;
          this._pipes = [];
          this._timeoutMs = 0;
          this._timer = null;
          this._hadError = false;
          this.connecting = false;
          this.pending = true;
          this.destroyed = false;
          this.readable = false;
          this.writable = false;
          this.readyState = 'closed';
          this.bytesRead = 0;
          this.bytesWritten = 0;
          this.writableEnded = false;
          this.writableFinished = false;
          this.allowHalfOpen = o.allowHalfOpen === true;
          this.remoteAddress = undefined;
          this.remoteFamily = undefined;
          this.remotePort = undefined;
          this.localAddress = undefined;
          this.localFamily = undefined;
          this.localPort = undefined;
          this.server = null;
          this.timeout = undefined;
        }
    /* The object the host calls back into. Every method here runs on the
     * loop's own turn with no realm borrow live, which is why it may
     * freely call back down into host.netWrite/netEnd. */
        _callbacks() {
          const self = this;
          return {
            onConnect() { self._opened(); self.emit('connect'); self.emit('ready'); },
            onData(u8) {
              self.bytesRead += u8.length;
              self._arm();
              const buf = Buffer.from(u8);
              self.emit('data', self._enc === null ? buf : buf.toString(self._enc));
            },
            onEnd() {
              self.readable = false;
              self.readyState = self.writable ? 'writeOnly' : 'closed';
              self.emit('end');
              if (!self.allowHalfOpen && !self.writableEnded) self.end();
            },
    /* Node's order on a socket error: 'error', then 'close' with
     * hadError true. The runtime destroys the socket right after the
     * error listeners run, so the close half arrives on its own. */
            onError(msg) { self._hadError = true; self.emit('error', netError(msg)); },
            onClose() {
              self._disarm();
              self._id = 0;
              self.destroyed = true;
              self.connecting = false;
              self.readable = false;
              self.writable = false;
              self.readyState = 'closed';
              if (self.server !== null) self.server._dropped();
              self.emit('close', self._hadError);
            },
          };
        }
        _opened() {
          this.connecting = false;
          this.pending = false;
          this.readable = true;
          this.writable = !this.writableEnded;
          this.readyState = this.writable ? 'open' : 'readOnly';
          const peer = host.netPeer(this._id);
          if (peer !== undefined) {
            this.remoteAddress = peer[0];
            this.remoteFamily = peer[1];
            this.remotePort = peer[2];
          }
          const local = host.netLocal(this._id);
          if (local !== undefined) {
            this.localAddress = local[0];
            this.localFamily = local[1];
            this.localPort = local[2];
          }
        }
    /* An accepted connection is already open: the server hands the id
     * over and the shim adopts it, then RETURNS its callbacks object so
     * the host can wire the listeners (the C island's onRequest shape). */
        _adopt(id, server) {
          this._id = id;
          this.server = server;
          this._opened();
          return this;
        }
        _arm() {
          if (this._timeoutMs <= 0) return;
          this._disarm();
          const self = this;
          this._timer = globalThis.setTimeout(() => { self._timer = null; self.emit('timeout'); }, this._timeoutMs);
        }
        _disarm() {
          if (this._timer !== null) { globalThis.clearTimeout(this._timer); this._timer = null; }
        }
        connect(...args) {
          let port = 0;
          let hostname = 'localhost';
          let cb = null;
          for (const a of args) {
            if (typeof a === 'function') cb = a;
            else if (typeof a === 'number') port = a;
            else if (typeof a === 'string') { if (port === 0) port = Number(a) || 0; else hostname = a; }
            else if (a !== null && typeof a === 'object') {
              if (a.port !== undefined) port = Number(a.port) || 0;
              if (typeof a.host === 'string') hostname = a.host;
              if (a.allowHalfOpen === true) this.allowHalfOpen = true;
              if (a.path !== undefined) {
                throw new Error("node:net IPC ('path') sockets are not supported in the scriptc island yet (TCP is)");
              }
            }
          }
          if (args.length >= 2 && typeof args[0] === 'number' && typeof args[1] === 'string') hostname = args[1];
          if (cb) this.once('connect', cb);
          this.connecting = true;
          this.readyState = 'opening';
          this._id = host.netConnect(port, hostname, this._callbacks());
          if (this._reading) host.netFlow(this._id, true);
          return this;
        }
    /* A Node socket flows when something reads it. These three overrides
     * are the only place that decision is made, so the shim's flag and
     * the loop's flag cannot drift. */
        on(name, fn) { const r = super.on(name, fn); if (name === 'data') this.resume(); return r; }
        addListener(name, fn) { return this.on(name, fn); }
        once(name, fn) { const r = super.once(name, fn); if (name === 'data') this.resume(); return r; }
        resume() { this._reading = true; if (this._id) host.netFlow(this._id, true); return this; }
        pause() { this._reading = false; if (this._id) host.netFlow(this._id, false); return this; }
        isPaused() { return !this._reading; }
        setEncoding(enc) { this._enc = enc === undefined || enc === null ? null : String(enc); return this; }
        read() { return null; }
        write(chunk, enc, cb) {
          if (typeof enc === 'function') { cb = enc; enc = undefined; }
          if (this.writableEnded || this.destroyed) {
            const err = new Error('This socket has been ended by the other party');
            err.code = 'EPIPE';
            if (cb) later(() => cb(err));
            else { const self = this; later(() => self.emit('error', err)); }
            return false;
          }
          const u8 = toU8(chunk, enc);
          this.bytesWritten += u8.length;
          this._arm();
          if (this._id) host.netWrite(this._id, u8);
          if (cb) later(cb);
          return true;
        }
        end(chunk, enc, cb) {
          if (typeof chunk === 'function') { cb = chunk; chunk = undefined; enc = undefined; }
          else if (typeof enc === 'function') { cb = enc; enc = undefined; }
          if (this.writableEnded) { if (cb) later(cb); return this; }
          const tail = (chunk === undefined || chunk === null || chunk === '') ? undefined : toU8(chunk, enc);
          if (tail !== undefined) this.bytesWritten += tail.length;
          this.writableEnded = true;
          this.writable = false;
          this.readyState = this.readable ? 'readOnly' : 'closed';
          if (this._id) host.netEnd(this._id, tail);
          const self = this;
          later(() => { self.writableFinished = true; if (cb) cb(); self.emit('finish'); });
          return this;
        }
        destroy(err) {
          if (this.destroyed) return this;
          if (err) {
            this._hadError = true;
            const self = this;
            later(() => self.emit('error', err));
          }
          if (this._id) host.netDestroy(this._id);
          else {
            this.destroyed = true;
            const self = this;
            later(() => self.emit('close', self._hadError));
          }
          return this;
        }
        destroySoon() { this.end(); }
        setNoDelay(enable) {
          const v = enable === undefined ? true : !!enable;
          if (this._id) host.netOption(this._id, 'noDelay', v);
          return this;
        }
        setKeepAlive(enable, _delay) {
          const v = enable === undefined ? true : !!enable;
          if (this._id) host.netOption(this._id, 'keepAlive', v);
          return this;
        }
        setTimeout(ms, cb) {
          this._timeoutMs = Number(ms) || 0;
          this.timeout = this._timeoutMs === 0 ? undefined : this._timeoutMs;
          if (cb) this.on('timeout', cb);
          if (this._timeoutMs === 0) this._disarm(); else this._arm();
          return this;
        }
        address() {
          if (!this._id) return {};
          const a = host.netLocal(this._id);
          return a === undefined ? {} : { address: a[0], family: a[1], port: a[2] };
        }
        ref() { return this; }
        unref() { return this; }
        cork() {}
        uncork() {}
        pipe(dest, opts) {
          const self = this;
          const endDest = !(opts && opts.end === false);
          const onData = (chunk) => { dest.write(chunk); };
          const onEnd = () => { self.removeListener('data', onData); if (endDest) dest.end(); };
          this.on('data', onData);
          this.once('end', onEnd);
          this._pipes.push([dest, onData, onEnd]);
          dest.emit('pipe', this);
          return dest;
        }
        unpipe(dest) {
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
      }

      class Server extends EventEmitter {
        constructor(options, handler) {
          super();
          if (typeof options === 'function') { handler = options; options = undefined; }
          const o = options === null || options === undefined ? {} : options;
          this.listening = false;
          this.maxConnections = 0;
          this._connections = 0;
          this.allowHalfOpen = o.allowHalfOpen === true;
          this.pauseOnConnect = o.pauseOnConnect === true;
          if (handler) this.on('connection', handler);
          const self = this;
          this._id = host.netServerCreate({
            onListening() { self.listening = true; self.emit('listening'); },
            onClose() { self.listening = false; self.emit('close'); },
            onError(msg) { self.listening = false; self.emit('error', netError(msg)); },
            onConnection(id) {
              const socket = new Socket({ allowHalfOpen: self.allowHalfOpen });
              socket._adopt(id, self);
              self._connections += 1;
              self.emit('connection', socket);
              return socket._callbacks();
            },
          });
        }
        _dropped() {
          if (this._connections > 0) this._connections -= 1;
        }
    /* listen([port[, host[, backlog]]][, cb]) and listen(options[, cb]) —
     * the http Server's parse, because both reach the same bind. The
     * bound port is the kernel's answer for port 0 and becomes readable
     * through address() once 'listening' has fired. */
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
          host.netServerListen(this._id, port, hostname);
          return this;
        }
        address() {
          if (!this.listening) return null;
          const a = host.netServerAddress(this._id);
          return a === undefined ? null : { address: a[0], family: a[1], port: a[2] };
        }
        close(cb) {
          if (cb) this.once('close', cb);
          host.netServerClose(this._id);
          return this;
        }
        getConnections(cb) { const n = this._connections; if (cb) later(() => cb(null, n)); return this; }
        ref() { return this; }
        unref() { return this; }
        setTimeout(_ms, cb) { if (cb) this.on('timeout', cb); return this; }
      }

      const createConnection = (...args) => {
        let options = null;
        for (const a of args) { if (a !== null && typeof a === 'object' && typeof a !== 'function') options = a; }
        const socket = new Socket(options);
        return socket.connect(...args);
      };
      const createServer = (options, handler) => new Server(options, handler);
      const mod = {
        isIP: fenced.isIP, isIPv4: fenced.isIPv4, isIPv6: fenced.isIPv6,
        connect: createConnection, createConnection, createServer,
        Socket, Server,
      };
      mod.default = mod;
      return mod;
    });
  }
