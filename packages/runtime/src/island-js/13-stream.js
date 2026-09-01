    /* node:stream (+ stream/promises, stream/consumers, stream/web) —
     * the five stream classes over the events shim, with Node's
     * observable ordering (state.sync deferral, prefinish ticks,
     * finish/end per final-hook presence), pipe chains with
     * drain-based backpressure, pipeline/finished both spellings,
     * and async iteration — differentially pinned against Node. */
  builtins.stream = memo(() => {
function makeStream(env) {
  const EventEmitter = env.EventEmitter;
  const Buffer = env.Buffer;
  const StringDecoder = env.StringDecoder;
  const nextTick = env.nextTick;
  const ERR_PREMATURE = () => {
    const e = new Error("Premature close");
    e.code = "ERR_STREAM_PREMATURE_CLOSE";
    return e;
  };
  const ERR_PUSH_AFTER_EOF = () => {
    const e = new Error("stream.push() after EOF");
    e.code = "ERR_STREAM_PUSH_AFTER_EOF";
    return e;
  };
  const ERR_WRITE_AFTER_END = () => {
    const e = new Error("write after end");
    e.code = "ERR_STREAM_WRITE_AFTER_END";
    return e;
  };
  const ERR_DESTROYED = (what) => {
    const e = new Error("Cannot call " + what + " after a stream was destroyed");
    e.code = "ERR_STREAM_DESTROYED";
    return e;
  };
  const ERR_METHOD_NOT_IMPLEMENTED = (name) => {
    const e = new Error("The " + name + " method is not implemented");
    e.code = "ERR_METHOD_NOT_IMPLEMENTED";
    return e;
  };
  class Stream extends EventEmitter {
    constructor(opts) {
      super();
      void opts;
    }
    pipe(dest, options) {
      return pipeImpl(this, dest, options);
    }
  }
  const chunkOf = (stream, chunk, encoding) => {
    if (stream._objectMode) return chunk;
    if (typeof chunk === "string") return Buffer.from(chunk, encoding === undefined || encoding === null || encoding === "buffer" ? "utf8" : encoding);
    return chunk;
  };
  class Readable extends Stream {
    constructor(options) {
      super();
      const opts = options || {};
      this._objectMode = !!(opts.objectMode || opts.readableObjectMode);
    /* Node's default highWaterMark is platform-split at the source
     * (lib/internal/streams/state.js: `process.platform === 'win32' ?
     * 16 * 1024 : 64 * 1024`) — the same split scr_stream.c decides for
     * the static lane as SCR_STREAM_DEFAULT_HWM. The C island used to
     * splice the target's value in at BUILD time (an ISL_STREAM_DEFAULT_HWM
     * macro); shared JS asks the host at runtime instead, which is the
     * same answer on the same target and the only spelling both islands
     * can hold. */
      this._hwm = opts.highWaterMark !== undefined ? opts.highWaterMark
        : opts.readableHighWaterMark !== undefined ? opts.readableHighWaterMark
        : this._objectMode ? 16 : (host.platform() === 'win32' ? 16384 : 65536);
      if (typeof opts.read === "function") this._read = opts.read;
      if (typeof opts.destroy === "function") this._destroy = opts.destroy;
      this._rBuf = [];
      this._rLen = 0;
      this._sync = true; /* Node's state.sync: true at start and during _read */
      this._flowing = null;
      this._rEnded = false; /* push(null) seen */
      this._rEmittedEnd = false;
      this._reading = false;
      this._readRequested = false;
      this.destroyed = false;
      this._rErrored = null;
      this._decoder = null;
      this._encoding = null;
      this._closeEmitted = false;
      if (opts.encoding) this.setEncoding(opts.encoding);
      if (typeof opts.signal === "object" && opts.signal !== null && typeof opts.signal.addEventListener === "function") {
        opts.signal.addEventListener("abort", () => {
          const e = new Error("The operation was aborted");
          e.code = "ABORT_ERR";
          e.name = "AbortError";
          this.destroy(e);
        });
      }
    }
    get readableEnded() { return this._rEmittedEnd; }
    get readableFlowing() { return this._flowing; }
    get readableLength() { return this._rLen; }
    get readableHighWaterMark() { return this._hwm; }
    get readableObjectMode() { return this._objectMode; }
    get readable() {
      return !this._rEmittedEnd && !this.destroyed && this._rErrored === null;
    }
    get errored() { return this._rErrored; }
    get closed() { return this._closeEmitted; }
    _read() {
      throw ERR_METHOD_NOT_IMPLEMENTED("_read()");
    }
    setEncoding(enc) {
      this._decoder = new StringDecoder(enc);
      this._encoding = this._decoder.encoding;
      if (this._rBuf.length) {
        const chunks = this._rBuf;
        this._rBuf = [];
        this._rLen = 0;
        for (const c of chunks) {
          const s = typeof c === "string" ? c : this._decoder.write(c);
          if (s.length) {
            this._rBuf.push(s);
            this._rLen += s.length;
          }
        }
      }
      return this;
    }
    push(chunk, encoding) {
      if (chunk === null) {
        this._rEnded = true;
        this._maybeEmitEnd();
        return false;
      }
      if (this._rEmittedEnd || (this._rEnded && !this._objectMode)) {
        this.emit("error", ERR_PUSH_AFTER_EOF());
        return false;
      }
      let c = chunkOf(this, chunk, encoding);
      if (this._decoder && typeof c !== "string") {
        c = this._decoder.write(c);
        if (c.length === 0) return !this._rEnded && this._rLen < this._hwm;
      }
      this._rBuf.push(c);
      this._rLen += this._objectMode ? 1 : c.length;
      this._pushed = true;
      if (this._flowing === true && this._rLen === (this._objectMode ? 1 : c.length) && !this._sync && !this._reading) {
        this._takeChunk();
        this.emit("data", c);
      } else if (this._flowing === true) {
        if (!this._reading) nextTick(() => this._emitData());
      } else {
        nextTick(() => this.emit("readable"));
      }
      return !this._rEnded && this._rLen < this._hwm;
    }
    unshift(chunk, encoding) {
      if (chunk === null || chunk === undefined) return;
      let c = chunkOf(this, chunk, encoding);
      if (this._decoder && typeof c !== "string") c = this._decoder.write(c);
      this._rBuf.unshift(c);
      this._rLen += this._objectMode ? 1 : c.length;
    }
    _callRead() {
      while (!this._reading && !this._rEnded && !this.destroyed) {
        this._reading = true;
        this._pushed = false;
        this._sync = true;
        try {
          this._read(this._hwm);
        } catch (err) {
          this.destroy(err);
        }
        this._sync = false;
        this._reading = false;
        if (this._flowing === true) this._drainData();
        else this._maybeEmitEnd();
        if (!(this._flowing === true && this._pushed && !this._rEnded && !this.destroyed)) break;
      }
    }
    _drainData() {
      while (this._flowing === true && this._rBuf.length > 0 && !this.destroyed) {
        const c = this._takeChunk();
        this.emit("data", c);
      }
      this._maybeEmitEnd();
    }
    _emitData() {
      this._drainData();
      if (this._flowing === true && !this._rEnded && !this.destroyed) {
        this._callRead();
      }
    }
    _takeChunk() {
      const c = this._rBuf.shift();
      this._rLen -= this._objectMode ? 1 : c.length;
      return c;
    }
    _maybeEmitEnd() {
      if (this._rEnded && this._rBuf.length === 0 && !this._rEmittedEnd && !this.destroyed) {
        this._rEmittedEnd = true;
        if (this._decoder) {
          const tail = this._decoder.end();
          if (tail.length) {
            this._rEmittedEnd = false;
            this._rBuf.push(tail);
            this._rLen += tail.length;
            if (this._flowing === true) this._emitData();
            return;
          }
        }
        nextTick(() => {
          this.emit("end");
          this._maybeClose();
        });
      }
    }
    _maybeClose() {
      if (this._closeEmitted || this.destroyed) return;
      this._closeEmitted = true;
      nextTick(() => this.emit("close"));
    }
    _takeAll() {
      const out = this._decoder || typeof this._rBuf[0] === "string" ? this._rBuf.join("") : Buffer.concat(this._rBuf);
      this._rBuf = [];
      this._rLen = 0;
      this._maybeEmitEnd();
      return out;
    }
    read(n) {
      if (this._rBuf.length === 0) {
        this._callRead();
      }
      if (this._rBuf.length === 0) {
        this._maybeEmitEnd();
        return null;
      }
      if (n === undefined || n === null || (typeof n === "number" && Number.isNaN(n))) {
        if (this._objectMode) return this._takeChunk();
        /* Node's howMuchToRead() answers a bare read() with
         * state.buffer.first().length, not state.length: raw Buffer mode
         * hands back exactly ONE queued chunk, so the boundaries created by
         * push() and unshift() survive the read. Only a stream with a
         * decoder attached collapses the queue into a single string. */
        if (this._decoder) return this._takeAll();
        const c = this._takeChunk();
        this._maybeEmitEnd();
        return c;
      }
      if (this._objectMode) return this._takeChunk();
      if (n <= 0) return null;
      if (this._rLen === 0) return null;
      if (n === this._rLen) return this._takeAll();
      if (n > this._rLen) {
        /* Node withholds a short read until the stream ends, then releases
         * whatever is left. Ask the source for more first: the buffer is
         * non-empty here, so the _callRead() above did not fire and nothing
         * else would wake a consumer that only ever asks for n bytes. */
        if (!this._rEnded) {
          this._callRead();
          if (this._rEnded && n > this._rLen) return this._rLen > 0 ? this._takeAll() : null;
          if (n <= this._rLen) return this.read(n);
          this._maybeEmitEnd();
          return null;
        }
        return this._takeAll();
      }
      let out;
      if (typeof this._rBuf[0] === "string") {
        let s = "";
        while (s.length < n && this._rBuf.length) {
          const c = this._takeChunk();
          if (s.length + c.length <= n) {
            s += c;
          } else {
            const take = n - s.length;
            s += c.slice(0, take);
            this._rBuf.unshift(c.slice(take));
            this._rLen += c.length - take;
          }
        }
        out = s;
      } else {
        const parts = [];
        let got = 0;
        while (got < n && this._rBuf.length) {
          const c = this._takeChunk();
          if (got + c.length <= n) {
            parts.push(c);
            got += c.length;
          } else {
            const take = n - got;
            parts.push(c.subarray(0, take));
            this._rBuf.unshift(c.subarray(take));
            this._rLen += c.length - take;
            got = n;
          }
        }
        out = Buffer.concat(parts);
      }
      this._maybeEmitEnd();
      return out;
    }
    on(name, fn) {
      super.on(name, fn);
      if (name === "data") {
        if (this._flowing !== false) {
          this._flowing = true;
          nextTick(() => this._emitData());
        }
      } else if (name === "readable") {
        if (this._rBuf.length > 0 || this._rEnded) {
          nextTick(() => this.emit("readable"));
        } else {
          nextTick(() => this._callRead());
        }
      }
      return this;
    }
    addListener(name, fn) { return this.on(name, fn); }
    pause() {
      this._flowing = false;
      return this;
    }
    resume() {
      if (this._flowing !== true) {
        this._flowing = true;
        nextTick(() => this._emitData());
      }
      return this;
    }
    isPaused() { return this._flowing === false; }
    _destroy(err, cb) { cb(err); }
    destroy(err) {
      if (this.destroyed) return this;
      this.destroyed = true;
      this._rErrored = err || null;
      this._destroy(err || null, (er) => {
        if (er) nextTick(() => this.emit("error", er));
        else if (err) nextTick(() => this.emit("error", err));
        if (!this._closeEmitted) {
          this._closeEmitted = true;
          nextTick(() => this.emit("close"));
        }
      });
      return this;
    }
    unpipe(dest) {
      unpipeImpl(this, dest);
      return this;
    }
    wrap() { throw ERR_METHOD_NOT_IMPLEMENTED("wrap()"); }
    [Symbol.asyncIterator]() {
      const stream = this;
      let done = false;
      return {
        next() {
          return new Promise((resolve, reject) => {
            if (done || stream._rEmittedEnd) {
              done = true;
              resolve({ value: undefined, done: true });
              return;
            }
            const tryRead = () => {
              const c = stream.read();
              if (c !== null) {
                cleanup();
                resolve({ value: c, done: false });
                return true;
              }
              if (stream._rEmittedEnd || (stream._rEnded && stream._rBuf.length === 0)) {
                cleanup();
                done = true;
                resolve({ value: undefined, done: true });
                return true;
              }
              return false;
            };
            const onReadable = () => { tryRead(); };
            const onEnd = () => {
              cleanup();
              done = true;
              resolve({ value: undefined, done: true });
            };
            const onError = (err) => {
              cleanup();
              done = true;
              reject(err);
            };
            const cleanup = () => {
              stream.removeListener("readable", onReadable);
              stream.removeListener("end", onEnd);
              stream.removeListener("error", onError);
            };
            if (tryRead()) return;
            stream.on("readable", onReadable);
            stream.on("end", onEnd);
            stream.on("error", onError);
          });
        },
        return() {
          done = true;
          stream.destroy();
          return Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator]() { return this; },
      };
    }
    static from(iterable) {
      const r = new Readable({ objectMode: true, read() {} });
      (async () => {
        try {
          if (typeof iterable === "string" || iterable instanceof Buffer || iterable instanceof Uint8Array) {
            r.push(iterable);
          } else {
            for await (const chunk of iterable) r.push(chunk);
          }
          r.push(null);
        } catch (err) {
          r.destroy(err);
        }
      })();
      return r;
    }
  }
  const pipeImpl = (src, dest, options) => {
    const endOnFinish = !options || options.end !== false;
    const onData = (chunk) => {
      const ok = dest.write(chunk);
      if (ok === false) src.pause();
    };
    const onDrain = () => src.resume();
    const onEnd = () => {
      if (endOnFinish) dest.end();
    };
    src.on("data", onData);
    dest.on("drain", onDrain);
    src.on("end", onEnd);
    const cleanup = () => {
      src.removeListener("data", onData);
      dest.removeListener("drain", onDrain);
      src.removeListener("end", onEnd);
    };
    if (!src._pipes) src._pipes = [];
    src._pipes.push({ dest, cleanup });
    dest.emit("pipe", src);
    return dest;
  };
  const unpipeImpl = (src, dest) => {
    if (!src._pipes) return;
    for (let i = src._pipes.length - 1; i >= 0; i--) {
      if (dest === undefined || src._pipes[i].dest === dest) {
        src._pipes[i].cleanup();
        const d = src._pipes[i].dest;
        src._pipes.splice(i, 1);
        d.emit("unpipe", src);
      }
    }
  };
  class Writable extends Stream {
    constructor(options) {
      super();
      const opts = options || {};
      this._objectMode = !!(opts.objectMode || opts.writableObjectMode);
      this._wom = this._objectMode;
      this._whwm = opts.highWaterMark !== undefined ? opts.highWaterMark
        : opts.writableHighWaterMark !== undefined ? opts.writableHighWaterMark
        : this._wom ? 16 : (host.platform() === 'win32' ? 16384 : 65536);
      if (typeof opts.write === "function") this._write = opts.write;
      if (typeof opts.writev === "function") this._writev = opts.writev;
      if (typeof opts.final === "function") this._final = opts.final;
      if (typeof opts.destroy === "function") this._destroy = opts.destroy;
      this._decodeStrings = opts.decodeStrings !== false;
      this._wQueue = [];
      this._wLen = 0;
      this._writing = false;
      this._wEnded = false;
      this._wFinished = false;
      this._needDrain = false;
      this.destroyed = false;
      this._wErrored = null;
      this._wCloseEmitted = false;
      this._defaultEncoding = opts.defaultEncoding || "utf8";
    }
    get writableEnded() { return this._wEnded; }
    get writableFinished() { return this._wFinished; }
    get writableLength() { return this._wLen; }
    get writableHighWaterMark() { return this._whwm; }
    get writableObjectMode() { return this._wom; }
    get writable() {
      return !this._wEnded && !this.destroyed && this._wErrored === null;
    }
    get errored() { return this._wErrored; }
    get closed() { return this._wCloseEmitted; }
    _write(chunk, encoding, callback) {
      if (this._writev) {
        this._writev([{ chunk, encoding }], callback);
        return;
      }
      throw ERR_METHOD_NOT_IMPLEMENTED("_write()");
    }
    write(chunk, encoding, callback) {
      if (typeof encoding === "function") {
        callback = encoding;
        encoding = null;
      }
      if (this._wEnded) {
        const err = ERR_WRITE_AFTER_END();
        nextTick(() => {
          if (typeof callback === "function") callback(err);
          this.emit("error", err);
        });
        return false;
      }
      if (this.destroyed) {
        const err = ERR_DESTROYED("write");
        nextTick(() => {
          if (typeof callback === "function") callback(err);
          this.emit("error", err);
        });
        return false;
      }
      let c = chunk;
      let enc = encoding || this._defaultEncoding;
      if (!this._wom && typeof chunk === "string" && this._decodeStrings) {
        c = Buffer.from(chunk, enc);
        enc = "buffer";
      } else if (!this._wom && typeof chunk !== "string") {
        enc = "buffer";
      }
      this._wQueue.push({ chunk: c, encoding: enc, callback });
      this._wLen += this._wom ? 1 : (c.length !== undefined ? c.length : 1);
      const ret = this._wLen < this._whwm;
      if (!ret) this._needDrain = true;
      this._processWrites();
      return ret;
    }
    _processWrites() {
      if (this._writing || this.destroyed) return;
      const entry = this._wQueue.shift();
      if (entry === undefined) {
        if (this._wEnded && !this._wFinished && !this._finalCalled) {
          this._finalCalled = true;
          if (this._final) nextTick(() => this._runFinal());
          else this._runFinal();
        }
        if (this._needDrain && !this._wEnded) {
          this._needDrain = false;
          nextTick(() => this.emit("drain"));
        }
        return;
      }
      this._runWrite(entry);
    }
    _runFinal() {
      const finish = (err) => {
        if (err) {
          this.destroy(err);
          return;
        }
        this._wFinished = true;
        nextTick(() => {
          this.emit("finish");
          this._maybeCloseW();
        });
      };
      if (this._final) {
        try {
          this._final.call(this, finish);
        } catch (err) {
          finish(err);
        }
      } else {
        finish();
      }
    }
    _runWrite(entry) {
      this._writing = true;
      const done = (err) => {
        this._writing = false;
        this._wLen -= this._wom ? 1 : (entry.chunk.length !== undefined ? entry.chunk.length : 1);
        if (typeof entry.callback === "function") {
          nextTick(() => entry.callback(err || null));
        }
        if (err) {
          this.destroy(err);
          return;
        }
        nextTick(() => this._processWrites());
      };
      try {
        this._write.call(this, entry.chunk, entry.encoding, done);
      } catch (err) {
        done(err);
      }
    }
    end(chunk, encoding, callback) {
      if (typeof chunk === "function") {
        callback = chunk;
        chunk = null;
        encoding = null;
      } else if (typeof encoding === "function") {
        callback = encoding;
        encoding = null;
      }
      if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);
      this._wEnded = true;
      if (typeof callback === "function") {
        if (this._wFinished) nextTick(callback);
        else if (typeof this.prependOnceListener === "function") this.prependOnceListener("finish", () => callback());
        else this.once("finish", () => callback());
      }
      this._processWrites();
      return this;
    }
    cork() {}
    uncork() {}
    setDefaultEncoding(enc) {
      this._defaultEncoding = enc;
      return this;
    }
    _destroy(err, cb) { cb(err); }
    destroy(err) {
      if (this.destroyed) return this;
      this.destroyed = true;
      this._wErrored = err || null;
      this._destroy(err || null, (er) => {
        const finalErr = er || err;
        if (finalErr) nextTick(() => this.emit("error", finalErr));
        this._maybeCloseW();
      });
      return this;
    }
    _maybeCloseW() {
      if (this._wCloseEmitted) return;
      this._wCloseEmitted = true;
      nextTick(() => this.emit("close"));
    }
  }
  class Duplex extends Readable {
    constructor(options) {
      super(options);
      const opts = options || {};
      const w = new Writable(opts);
      this._wSide = w;
      this._whwm = w._whwm;
      this._wQueue = w._wQueue;
      if (typeof opts.write === "function") this._write = opts.write;
      if (typeof opts.writev === "function") this._writev = opts.writev;
      if (typeof opts.final === "function") this._final = opts.final;
      this._wObjectMode = !!(opts.objectMode || opts.writableObjectMode);
      this._decodeStrings = opts.decodeStrings !== false;
      this._wLen = 0;
      this._writing = false;
      this._wEnded = false;
      this._wFinished = false;
      this._needDrain = false;
      this._wErrored = null;
      this._wCloseEmitted = false;
      this._finalCalled = false;
      this._defaultEncoding = opts.defaultEncoding || "utf8";
      this.allowHalfOpen = opts.allowHalfOpen !== false;
    }
    get writableEnded() { return this._wEnded; }
    get writableFinished() { return this._wFinished; }
    get writableLength() { return this._wLen; }
    get writableHighWaterMark() { return this._whwm; }
    get writableObjectMode() { return this._wom; }
    get writable() {
      return !this._wEnded && !this.destroyed && this._wErrored === null;
    }
  }
  for (const m of ["_write", "write", "_processWrites", "_runFinal", "_runWrite", "end", "cork", "uncork", "setDefaultEncoding", "_maybeCloseW"]) {
    Duplex.prototype[m] = Writable.prototype[m];
  }
  Duplex.prototype._maybeCloseW = function () {
    this._maybeClose();
  };
  class Transform extends Duplex {
    constructor(options) {
      super(options);
      const opts = options || {};
      if (typeof opts.transform === "function") this._transform = opts.transform;
      if (typeof opts.flush === "function") this._flush = opts.flush;
    }
    _read() {}
    _transform() {
      throw ERR_METHOD_NOT_IMPLEMENTED("_transform()");
    }
    _write(chunk, encoding, callback) {
      try {
        this._transform.call(this, chunk, encoding, (err, data) => {
          if (err) {
            callback(err);
            return;
          }
          if (data !== undefined && data !== null) this.push(data);
          callback();
        });
      } catch (err) {
        callback(err);
      }
    }
    _final(callback) {
      if (this._flushCalled) {
        callback();
        return;
      }
      this._flushCalled = true;
      if (this._flush) {
        try {
          this._flush.call(this, (err, data) => {
            if (err) {
              callback(err);
              return;
            }
            if (data !== undefined && data !== null) this.push(data);
            this.push(null);
            callback();
          });
        } catch (err) {
          callback(err);
        }
      } else {
        this.push(null);
        callback();
      }
    }
  }
  class PassThrough extends Transform {
    _transform(chunk, encoding, callback) {
      callback(null, chunk);
    }
  }
  const isReadableLike = (s) => s instanceof Readable || (s && typeof s.on === "function" && typeof s.read === "function" && typeof s.write !== "function");
  const finished = (stream, opts, callback) => {
    if (typeof opts === "function") {
      callback = opts;
      opts = {};
    }
    let called = false;
    const done = (err) => {
      if (called) return;
      called = true;
      cleanup();
      callback.call(stream, err);
    };
    const readable = typeof stream.push === "function" || typeof stream.read === "function";
    const writable = typeof stream.write === "function";
    let readableEnded = !readable || stream._rEmittedEnd === true;
    let writableFinished = !writable || stream._wFinished === true;
    const onEnd = () => {
      readableEnded = true;
      if (writableFinished) done(null);
    };
    const onFinish = () => {
      writableFinished = true;
      if (readableEnded) done(null);
    };
    const onError = (err) => done(err);
    const onClose = () => {
      if (readableEnded && writableFinished) {
        done(null);
      } else if (stream.destroyed && stream.errored) {
        done(stream.errored);
      } else {
        done(ERR_PREMATURE());
      }
    };
    const cleanup = () => {
      stream.removeListener("end", onEnd);
      stream.removeListener("finish", onFinish);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
    };
    if (readableEnded && writableFinished) {
      nextTick(() => done(null));
      return () => {};
    }
    if (stream.destroyed) {
      nextTick(() => onClose());
      return () => {};
    }
    stream.on("end", onEnd);
    stream.on("finish", onFinish);
    stream.on("error", onError);
    stream.on("close", onClose);
    return cleanup;
  };
  const pipeline = (...args) => {
    const callback = args.pop();
    if (typeof callback !== "function") {
      const e = new TypeError('The "callback" argument must be of type function');
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    let streams = Array.isArray(args[0]) && args.length === 1 ? args[0] : args;
    if (streams.length < 2) {
      const e = new TypeError("The `streams` argument must be specified");
      e.code = "ERR_MISSING_ARGS";
      throw e;
    }
    if (typeof streams[0][Symbol.asyncIterator] === "function" && typeof streams[0].pipe !== "function") {
      streams = [Readable.from(streams[0]), ...streams.slice(1)];
    } else if (typeof streams[0][Symbol.iterator] === "function" && typeof streams[0].pipe !== "function" && typeof streams[0] !== "string") {
      streams = [Readable.from(streams[0]), ...streams.slice(1)];
    }
    let settled = false;
    const tail = streams[streams.length - 1];
    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        for (const s of streams) {
          if (typeof s.destroy === "function" && !s.destroyed) s.destroy(err);
        }
      }
      callback(err || null);
    };
    for (let i = 0; i < streams.length; i++) {
      streams[i].on("error", (err) => settle(err));
    }
    finished(tail, (err) => settle(err));
    for (let i = 0; i < streams.length - 1; i++) {
      streams[i].pipe(streams[i + 1]);
    }
    return tail;
  };
  const promises = {
    pipeline: (...streams) => new Promise((resolve, reject) => {
      pipeline(...streams, (err) => (err ? reject(err) : resolve()));
    }),
    finished: (stream, opts) => new Promise((resolve, reject) => {
      finished(stream, opts || {}, (err) => (err ? reject(err) : resolve()));
    }),
  };
  const consumers = {
    text: async (stream) => {
      let out = "";
      const dec = new StringDecoder("utf8");
      for await (const chunk of stream) {
        out += typeof chunk === "string" ? chunk : dec.write(chunk);
      }
      out += dec.end();
      return out;
    },
    buffer: async (stream) => {
      const parts = [];
      for await (const chunk of stream) {
        parts.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk.buffer === undefined ? chunk : chunk));
      }
      return Buffer.concat(parts);
    },
    arrayBuffer: async (stream) => {
      const buf = await consumers.buffer(stream);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    json: async (stream) => JSON.parse(await consumers.text(stream)),
    blob: async () => {
      throw new Error("stream.consumers.blob is not available in the scriptc island");
    },
  };
  const addAbortSignal = (signal, stream) => {
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", () => {
        const e = new Error("The operation was aborted");
        e.code = "ABORT_ERR";
        e.name = "AbortError";
        stream.destroy(e);
      });
    }
    return stream;
  };
  Stream.Stream = Stream;
  Stream.Readable = Readable;
  Stream.Writable = Writable;
  Stream.Duplex = Duplex;
  Stream.Transform = Transform;
  Stream.PassThrough = PassThrough;
  Stream.pipeline = pipeline;
  Stream.finished = finished;
  Stream.addAbortSignal = addAbortSignal;
  Stream.promises = promises;
  Stream.isErrored = (s) => !!(s && s.errored);
  Stream.isDestroyed = (s) => !!(s && s.destroyed);
  Stream.isReadable = (s) => !!(s && s.readable);
  Stream.isWritable = (s) => !!(s && s.writable);
  void isReadableLike;
  return { Stream, Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished, addAbortSignal, promises, consumers };
}
    const mod = makeStream({ EventEmitter: builtins.events(), Buffer: builtins.buffer().Buffer, StringDecoder: builtins.string_decoder().StringDecoder, nextTick: (fn) => queueMicrotask(fn) });
    const s = mod.Stream;
    s.default = s;
    return s;
  });
  builtins['stream/promises'] = memo(() => {
    const p = { ...builtins.stream().promises };
    p.default = p;
    return p;
  });
    /* stream/consumers lives on the shim factory result; the stream
     * module itself does not re-export it (Node's layout). */
  builtins['stream/consumers'] = memo(() => {
    const Buffer = builtins.buffer().Buffer;
    const SD = builtins.string_decoder().StringDecoder;
    const text = async (stream) => {
      let out = '';
      const d = new SD('utf8');
      for await (const chunk of stream) out += typeof chunk === 'string' ? chunk : d.write(chunk);
      return out + d.end();
    };
    const buffer = async (stream) => {
      const parts = [];
      for await (const chunk of stream) parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
      return Buffer.concat(parts);
    };
    const arrayBuffer = async (stream) => {
      const b = await buffer(stream);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    };
    const json = async (stream) => JSON.parse(await text(stream));
    const blob = async () => { throw new Error('stream.consumers.blob is not available in the scriptc island'); };
    const c = { text, buffer, arrayBuffer, json, blob };
    c.default = c;
    return c;
  });
    /* stream/web re-exports the web prelude's classes; names the
     * prelude does not carry stay undefined (honest absence). */
  builtins['stream/web'] = memo(() => {
    const g = globalThis;
    const w = {
      ReadableStream: g.ReadableStream, WritableStream: g.WritableStream,
      TransformStream: g.TransformStream, TextEncoderStream: g.TextEncoderStream,
      TextDecoderStream: g.TextDecoderStream,
      CountQueuingStrategy: g.CountQueuingStrategy, ByteLengthQueuingStrategy: g.ByteLengthQueuingStrategy,
      ReadableStreamDefaultReader: g.ReadableStreamDefaultReader,
      ReadableStreamDefaultController: g.ReadableStreamDefaultController,
      WritableStreamDefaultWriter: g.WritableStreamDefaultWriter,
    };
    w.default = w;
    return w;
  });
