    /* node:zlib — one-shot sync/callback codecs over the zlib bridge
     * (zlib/raw/gzip modes; inflate auto-detects for unzip), plus
     * BUFFERING stream classes: a Transform that collects its input
     * and converts at flush (no incremental output — documented
     * divergence). Brotli is not carried; its names exist and throw
     * at the call. */
  builtins.zlib = memo(() => {
    const Buffer = builtins.buffer().Buffer;
    const Transform = builtins.stream().Transform;
    const toU8 = (data) => {
      if (typeof data === 'string') return Buffer.from(data, 'utf8');
      if (data instanceof Uint8Array) return data;
      if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      const e = new TypeError('The "buffer" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer. Received ' + (data === null ? 'null' : typeof data === 'object' ? 'an instance of ' + ((data.constructor && data.constructor.name) || 'Object') : 'type ' + typeof data));
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    };
    const codec = (deflating, mode) => (data, options) => {
      const level = options !== undefined && options !== null && options.level !== undefined ? options.level : -1;
      const raw = host.zlib(deflating ? 1 : 0, toU8(data), mode, level);
      return Buffer.from(raw.buffer, raw.byteOffset, raw.length);
    };
    const asyncify = (syncFn) => (data, optionsOrCb, maybeCb) => {
      const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
      const options = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
      if (typeof cb !== 'function') {
        const e = new TypeError('The "callback" argument must be of type function');
        e.code = 'ERR_INVALID_ARG_TYPE';
        throw e;
      }
      let out;
      try { out = syncFn(data, options); }
      catch (err) { queueMicrotask(() => cb(err)); return; }
      queueMicrotask(() => cb(null, out));
    };
    const mkStreamClass = (name, syncFn) => {
      const cls = class extends Transform {
        constructor(options) {
          super({});
          this._zopts = options;
          this._zchunks = [];
          this.bytesWritten = 0;
        }
        _transform(chunk, enc, cb) {
          this._zchunks.push(toU8(chunk));
          this.bytesWritten += chunk.length;
          cb();
        }
        _flush(cb) {
          try {
            cb(null, syncFn(Buffer.concat(this._zchunks), this._zopts));
          } catch (err) {
            cb(err);
          }
        }
        close(cb) { if (typeof cb === 'function') queueMicrotask(cb); }
        reset() { this._zchunks = []; }
        flush(k, cb) { const f = typeof k === 'function' ? k : cb; if (typeof f === 'function') queueMicrotask(f); }
      };
      Object.defineProperty(cls, 'name', { value: name, configurable: true });
      return cls;
    };
    const die = (name) => class { constructor() { throw new Error('zlib.' + name + ' is not available in the scriptc island (brotli/zstd are not linked)'); } };
    const deflateSync = codec(true, 0), inflateSync = codec(false, 0);
    const deflateRawSync = codec(true, 1), inflateRawSync = codec(false, 1);
    const gzipSync = codec(true, 2), gunzipSync = codec(false, 2);
    const unzipSync = codec(false, 3);
    const Deflate = mkStreamClass('Deflate', deflateSync), Inflate = mkStreamClass('Inflate', inflateSync);
    const DeflateRaw = mkStreamClass('DeflateRaw', deflateRawSync), InflateRaw = mkStreamClass('InflateRaw', inflateRawSync);
    const Gzip = mkStreamClass('Gzip', gzipSync), Gunzip = mkStreamClass('Gunzip', gunzipSync);
    const Unzip = mkStreamClass('Unzip', unzipSync);
    const BrotliCompress = die('BrotliCompress'), BrotliDecompress = die('BrotliDecompress');
    const constants = {
      Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6,
      Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
      Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
      Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
      Z_DEFAULT_WINDOWBITS: 15, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15,
      Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384,
      Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8,
      Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
      ZLIB_VERNUM: 4865,
      BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2,
      BROTLI_PARAM_MODE: 0, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_SIZE_HINT: 3,
      BROTLI_MAX_QUALITY: 11, BROTLI_MIN_QUALITY: 0, BROTLI_DEFAULT_QUALITY: 11,
    };
    const z = {
      deflateSync, inflateSync, deflateRawSync, inflateRawSync, gzipSync, gunzipSync, unzipSync,
      deflate: asyncify(deflateSync), inflate: asyncify(inflateSync),
      deflateRaw: asyncify(deflateRawSync), inflateRaw: asyncify(inflateRawSync),
      gzip: asyncify(gzipSync), gunzip: asyncify(gunzipSync), unzip: asyncify(unzipSync),
      Deflate, Inflate, DeflateRaw, InflateRaw, Gzip, Gunzip, Unzip, BrotliCompress, BrotliDecompress,
      createDeflate: (o) => new Deflate(o), createInflate: (o) => new Inflate(o),
      createDeflateRaw: (o) => new DeflateRaw(o), createInflateRaw: (o) => new InflateRaw(o),
      createGzip: (o) => new Gzip(o), createGunzip: (o) => new Gunzip(o), createUnzip: (o) => new Unzip(o),
      createBrotliCompress: () => new BrotliCompress(), createBrotliDecompress: () => new BrotliDecompress(),
      brotliCompressSync: () => { throw new Error('zlib.brotliCompressSync is not available in the scriptc island'); },
      brotliDecompressSync: () => { throw new Error('zlib.brotliDecompressSync is not available in the scriptc island'); },
      constants,
    };
    z.default = z;
    return z;
  });
