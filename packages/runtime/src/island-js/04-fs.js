    /* node:fs (+ fs/promises) — the host fs bridge over the SAME
     * scr_fs_* implementations the static lowerings call: sync,
     * callback, and promises spellings (the I/O is synchronous;
     * callbacks/promises settle on the microtask queue), Stats/
     * Dirent shaping, and memory-backed create*Stream. Errors arrive
     * Node-shaped with the errno-name code. */
  builtins.fs = memo(() => {
function makeFs(env) {
  const Buffer = env.Buffer;
  const constants = env.fsConstants();
  /* The host's fs errors carry Node's message and `code`; the other
   * Node fields — `syscall`, `path` (and `dest`), `errno` — are stamped
   * here from that fixed message shape ("ENOENT: no such file or
   * directory, open '/x'"), which is what Effect's FileSystem and the
   * fs-extra family read to classify failures. */
  const ERRNO = { EPERM: -1, ENOENT: -2, EIO: -5, EBADF: -9, EAGAIN: -11, EACCES: -13, EBUSY: -16, EEXIST: -17, EXDEV: -18, ENOTDIR: -20, EISDIR: -21, EINVAL: -22, EMFILE: -24, ENOSPC: -28, EPIPE: -32, ENOTEMPTY: -39, ELOOP: -40, ENAMETOOLONG: -36 };
  const stampFsError = (e) => {
    if (e === null || typeof e !== "object" || typeof e.code !== "string" || typeof e.message !== "string") return;
    const m = /^([A-Z]+): .*?, ([a-z0-9_]+)(?: '((?:[^'\\]|\\.)*)'(?: -> '((?:[^'\\]|\\.)*)')?)?$/.exec(e.message);
    if (!m) return;
    if (e.syscall === undefined) e.syscall = m[2];
    if (m[3] !== undefined && e.path === undefined) e.path = m[3];
    if (m[4] !== undefined && e.dest === undefined) e.dest = m[4];
    if (e.errno === undefined && ERRNO[e.code] !== undefined) e.errno = ERRNO[e.code];
  };
  const call = (...args) => {
    try {
      return env.fs(...args);
    } catch (e) {
      stampFsError(e);
      throw e;
    }
  };
  const pathOf = (p) => {
    if (typeof p === "string") return p;
    if (p instanceof Uint8Array) return Buffer.from(p).toString("utf8");
    if (p !== null && typeof p === "object" && typeof p.href === "string" && p.href.startsWith("file://")) {
      return decodeURIComponent(p.href.slice(7));
    }
    const e = new TypeError('The "path" argument must be of type string or an instance of Buffer or URL. Received ' + (p === null ? "null" : typeof p === "object" ? "an instance of " + ((p.constructor && p.constructor.name) || "Object") : "type " + typeof p + " (" + JSON.stringify(p) + ")"));
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  };
  const encodingOf = (options, def) => {
    if (options === undefined || options === null) return def;
    if (typeof options === "string") return options;
    return options.encoding !== undefined && options.encoding !== null ? options.encoding : def;
  };
  const dataToU8 = (data, options) => {
    if (typeof data === "string") return Buffer.from(data, encodingOf(options, "utf8"));
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const e = new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ' + (data === null ? "null" : typeof data === "object" ? "an instance of " + ((data.constructor && data.constructor.name) || "Object") : "type " + typeof data));
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  };
  class Stats {
    constructor(row) {
      this._f = row[0];
      this._d = row[1];
      this._l = row[2];
      this.size = row[3];
      this.mtimeMs = row[4];
      this.blocks = row[5];
      this.nlink = row[6];
      this.atimeMs = row[7];
      this.atime = new Date(row[7]);
      this.mtime = new Date(row[4]);
      this.mode = (this._f ? constants.S_IFREG : this._d ? constants.S_IFDIR : this._l ? (constants.S_IFLNK || 0) : 0);
    }
    isFile() { return this._f; }
    isDirectory() { return this._d; }
    isSymbolicLink() { return this._l; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
  }
  class Dirent {
    constructor(name, kind, parentPath) {
      this.name = name;
      this.parentPath = parentPath;
      this.path = parentPath;
      this._kind = kind;
    }
    isFile() { return this._kind === 1; }
    isDirectory() { return this._kind === 2; }
    isSymbolicLink() { return this._kind === 3; }
    isFIFO() { return this._kind === 4; }
    isSocket() { return this._kind === 5; }
    isCharacterDevice() { return this._kind === 6; }
    isBlockDevice() { return this._kind === 7; }
  }
  const readFileSync = (p, options) => {
    const u8 = call("readFile", pathOf(p));
    const enc = encodingOf(options, null);
    const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.length);
    return enc === null ? buf : buf.toString(enc);
  };
  const writeFileSync = (p, data, options) => {
    call("writeFile", pathOf(p), dataToU8(data, options));
  };
  const appendFileSync = (p, data, options) => {
    call("appendFile", pathOf(p), dataToU8(data, options));
  };
  const existsSync = (p) => {
    try {
      return call("exists", pathOf(p));
    } catch (e) {
      return false;
    }
  };
  const realpathSync = (p) => call("realpath", pathOf(p));
  realpathSync.native = realpathSync;
  const mkdirSync = (p, options) => {
    const recursive = !!(options && options.recursive);
    const mode = options && options.mode !== undefined ? options.mode : -1;
    call("mkdir", pathOf(p), recursive ? 1 : 0, mode);
    return undefined;
  };
  const rmSync = (p, options) => {
    call("rm", pathOf(p), options && options.recursive ? 1 : 0, options && options.force ? 1 : 0);
  };
  const rmdirSync = (p) => call("rmdir", pathOf(p));
  const unlinkSync = (p) => call("unlink", pathOf(p));
  const readdirSync = (p, options) => {
    const path = pathOf(p);
    if (options && options.withFileTypes) {
      const flat = call("scandir", path);
      const out = [];
      for (let i = 0; i < flat.length; i += 2) out.push(new Dirent(flat[i], flat[i + 1], path));
      return out;
    }
    return call("readdir", path);
  };
  const statSync = (p, options) => {
    try {
      return new Stats(call("stat", pathOf(p)));
    } catch (e) {
      if (options && options.throwIfNoEntry === false && e.code === "ENOENT") return undefined;
      throw e;
    }
  };
  const lstatSync = (p, options) => {
    try {
      return new Stats(call("lstat", pathOf(p)));
    } catch (e) {
      if (options && options.throwIfNoEntry === false && e.code === "ENOENT") return undefined;
      throw e;
    }
  };
  const accessSync = (p, mode) => call("access", pathOf(p), mode === undefined ? constants.F_OK : mode);
  const mkdtempSync = (prefix) => call("mkdtemp", String(prefix));
  const chmodSync = (p, mode) => call("chmod", pathOf(p), mode);
  const readlinkSync = (p) => call("readlink", pathOf(p));
  const copyFileSync = (src, dest) => call("copyFile", pathOf(src), pathOf(dest));
  const renameSync = (src, dest) => call("rename", pathOf(src), pathOf(dest));
  /* Descriptor ops: the host keeps the open files; the fd is a number
   * the way Node hands it out. Numeric flags map onto Node's flag
   * strings, which the host's open parses. */
  const flagString = (flags) => {
    if (flags === undefined || flags === null) return "r";
    if (typeof flags === "string") return flags;
    const O = constants;
    const access = flags & (O.O_RDONLY | O.O_WRONLY | O.O_RDWR);
    const plus = access === O.O_RDWR ? "+" : "";
    const excl = (flags & O.O_EXCL) !== 0 ? "x" : "";
    if ((flags & O.O_APPEND) !== 0) return "a" + excl + plus;
    if ((flags & O.O_TRUNC) !== 0 || (flags & O.O_CREAT) !== 0) return "w" + excl + plus;
    return access === O.O_RDONLY ? "r" : "r+";
  };
  const fdOf = (fd) => {
    if (typeof fd !== "number") {
      const e = new TypeError('The "fd" argument must be of type number. Received ' + (fd === null ? "null" : typeof fd === "object" ? "an instance of " + (fd.constructor && fd.constructor.name) : "type " + typeof fd));
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    return fd;
  };
  const positionOf = (position) => (position === undefined || position === null ? -1 : Number(position));
  const u8View = (buffer) => (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  const openSync = (p, flags, mode) => call("open", pathOf(p), flagString(flags), mode === undefined ? -1 : mode);
  const closeSync = (fd) => { call("close", fdOf(fd)); };
  const fstatSync = (fd) => new Stats(call("fstat", fdOf(fd)));
  const ftruncateSync = (fd, len) => { call("ftruncate", fdOf(fd), len === undefined ? 0 : len); };
  const fsyncSync = (fd) => { call("fsync", fdOf(fd)); };
  const readSync = (fd, buffer, offsetOrOptions, length, position) => {
    let offset = offsetOrOptions;
    if (offsetOrOptions !== null && typeof offsetOrOptions === "object") ({ offset, length, position } = offsetOrOptions);
    if (offset === undefined || offset === null) offset = 0;
    if (length === undefined || length === null) length = buffer.byteLength - offset;
    if (length === 0) return 0;
    const chunk = call("read", fdOf(fd), length, positionOf(position));
    u8View(buffer).set(chunk, offset);
    return chunk.length;
  };
  const writeSync = (fd, data, offsetOrOptions, length, position) => {
    if (typeof data === "string") {
      const encoded = Buffer.from(data, typeof length === "string" ? length : "utf8");
      return call("write", fdOf(fd), u8View(encoded), positionOf(offsetOrOptions));
    }
    let offset = offsetOrOptions;
    if (offsetOrOptions !== null && typeof offsetOrOptions === "object") ({ offset, length, position } = offsetOrOptions);
    if (offset === undefined || offset === null) offset = 0;
    if (length === undefined || length === null) length = data.byteLength - offset;
    const view = u8View(data);
    return call("write", fdOf(fd), new Uint8Array(view.buffer, view.byteOffset + offset, length), positionOf(position));
  };
  /* Node's read(fd, …) spellings: (buffer, offset, length, position),
   * (buffer, {offset, length, position}), ({buffer, offset, length,
   * position}), or nothing but the callback. */
  const readArgs = (rest) => {
    let buffer = rest[0], offset, length, position;
    if (buffer === undefined || (buffer !== null && typeof buffer === "object" && !ArrayBuffer.isView(buffer))) {
      const o = buffer || {};
      buffer = o.buffer || Buffer.alloc(16384);
      offset = o.offset; length = o.length; position = o.position;
    } else if (rest.length >= 2 && rest[1] !== null && typeof rest[1] === "object") {
      ({ offset, length, position } = rest[1]);
    } else {
      offset = rest[1]; length = rest[2]; position = rest[3];
    }
    return [buffer, offset, length, position];
  };
  const sync = {
    openSync, closeSync, fstatSync, ftruncateSync, fsyncSync, readSync, writeSync,
    readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync,
    mkdirSync, rmSync, rmdirSync, unlinkSync, readdirSync, statSync,
    lstatSync, accessSync, mkdtempSync, chmodSync, copyFileSync, renameSync,
    readlinkSync,
  };
  const callbackify = (syncFn) => (...args) => {
    const cb = args.pop();
    if (typeof cb !== "function") {
      const e = new TypeError('The "cb" argument must be of type function. Received ' + (cb === undefined ? "undefined" : "type " + typeof cb));
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    let result;
    try {
      result = syncFn(...args);
    } catch (err) {
      env.nextTick(() => cb(err));
      return;
    }
    env.nextTick(() => cb(null, result));
  };
  const promisify = (syncFn) => (...args) => new Promise((resolve, reject) => {
    try {
      resolve(syncFn(...args));
    } catch (err) {
      reject(err);
    }
  });
  const fs = {
    ...sync,
    constants,
    Stats,
    Dirent,
    readFile: callbackify(readFileSync),
    writeFile: callbackify(writeFileSync),
    appendFile: callbackify(appendFileSync),
    exists: (p, cb) => {
      env.nextTick(() => cb(existsSync(p)));
    },
    realpath: Object.assign(callbackify(realpathSync), { native: callbackify(realpathSync) }),
    mkdir: callbackify(mkdirSync),
    rm: callbackify(rmSync),
    rmdir: callbackify(rmdirSync),
    unlink: callbackify(unlinkSync),
    readdir: callbackify(readdirSync),
    stat: callbackify(statSync),
    lstat: callbackify(lstatSync),
    access: callbackify(accessSync),
    mkdtemp: callbackify(mkdtempSync),
    chmod: callbackify(chmodSync),
    copyFile: callbackify(copyFileSync),
    rename: callbackify(renameSync),
    readlink: callbackify(readlinkSync),
    createReadStream: (p, options) => {
      const enc = typeof options === "string" ? options : options && options.encoding;
      const r = new env.Readable({
        read() {
          if (this._started) return;
          this._started = true;
          try {
            const buf = readFileSync(p);
            for (let i = 0; i < buf.length; i += 65536) this.push(buf.subarray(i, Math.min(i + 65536, buf.length)));
            this.push(null);
          } catch (err) {
            this.destroy(err);
          }
        },
      });
      if (enc) r.setEncoding(enc);
      r.path = typeof p === "string" ? p : pathOf(p);
      return r;
    },
    createWriteStream: (p, options) => {
      const chunks = [];
      const w = new env.Writable({
        write(chunk, e, cb) {
          chunks.push(chunk);
          cb();
        },
        final(cb) {
          try {
            const flags = options && options.flags;
            const data = Buffer.concat(chunks.map((c) => (typeof c === "string" ? Buffer.from(c) : c)));
            if (flags === "a") appendFileSync(p, data);
            else writeFileSync(p, data);
            cb();
          } catch (err) {
            cb(err);
          }
        },
      });
      w.path = typeof p === "string" ? p : pathOf(p);
      return w;
    },
    watch: () => {
      throw new Error("fs.watch is not available in the scriptc island");
    },
    watchFile: () => {
      throw new Error("fs.watchFile is not available in the scriptc island");
    },
    open: (p, flags, mode, cb) => {
      if (typeof flags === "function") { cb = flags; flags = undefined; mode = undefined; }
      else if (typeof mode === "function") { cb = mode; mode = undefined; }
      callbackify(openSync)(p, flags, mode, cb);
    },
    close: callbackify(closeSync),
    fstat: (fd, options, cb) => {
      if (typeof options === "function") cb = options;
      callbackify(fstatSync)(fd, cb);
    },
    ftruncate: (fd, len, cb) => {
      if (typeof len === "function") { cb = len; len = 0; }
      callbackify(ftruncateSync)(fd, len, cb);
    },
    fsync: callbackify(fsyncSync),
    read: (fd, ...rest) => {
      const cb = rest.pop();
      const [buffer, offset, length, position] = readArgs(rest);
      let n;
      try {
        n = readSync(fd, buffer, offset, length, position);
      } catch (err) {
        env.nextTick(() => cb(err));
        return;
      }
      env.nextTick(() => cb(null, n, buffer));
    },
    write: (fd, ...rest) => {
      const cb = rest.pop();
      let n;
      try {
        n = writeSync(fd, ...rest);
      } catch (err) {
        env.nextTick(() => cb(err));
        return;
      }
      env.nextTick(() => cb(null, n, rest[0]));
    },
    unwatchFile: () => undefined,
  };
  /* fs.promises.open: a FileHandle over the same descriptor bridge. */
  class FileHandle {
    constructor(fd) { this.fd = fd; }
    read(...rest) {
      const [buffer, offset, length, position] = readArgs(rest);
      return promisify(readSync)(this.fd, buffer, offset, length, position).then((bytesRead) => ({ bytesRead, buffer }));
    }
    write(data, ...rest) {
      return promisify(writeSync)(this.fd, data, ...rest).then((bytesWritten) => ({ bytesWritten, buffer: data }));
    }
    readFile(options) {
      return promisify(() => {
        const chunks = [];
        for (;;) {
          const chunk = call("read", fdOf(this.fd), 65536, -1);
          if (chunk.length === 0) break;
          chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
        }
        const buf = Buffer.concat(chunks);
        const enc = encodingOf(options, null);
        return enc === null ? buf : buf.toString(enc);
      })();
    }
    writeFile(data, options) {
      return promisify(writeSync)(this.fd, dataToU8(data, options)).then(() => undefined);
    }
    stat() { return promisify(fstatSync)(this.fd); }
    truncate(len) { return promisify(ftruncateSync)(this.fd, len); }
    sync() { return promisify(fsyncSync)(this.fd); }
    close() { return promisify(closeSync)(this.fd); }
  }
  if (typeof Symbol.asyncDispose === "symbol") {
    FileHandle.prototype[Symbol.asyncDispose] = function () { return this.close(); };
  }
  fs.promises = {
    readFile: promisify(readFileSync),
    writeFile: promisify(writeFileSync),
    appendFile: promisify(appendFileSync),
    realpath: promisify(realpathSync),
    mkdir: promisify(mkdirSync),
    rm: promisify(rmSync),
    rmdir: promisify(rmdirSync),
    unlink: promisify(unlinkSync),
    readdir: promisify(readdirSync),
    stat: promisify(statSync),
    lstat: promisify(lstatSync),
    access: promisify(accessSync),
    mkdtemp: promisify(mkdtempSync),
    chmod: promisify(chmodSync),
    copyFile: promisify(copyFileSync),
    rename: promisify(renameSync),
    readlink: promisify(readlinkSync),
    constants,
    open: (p, flags, mode) => promisify(openSync)(p, flags, mode).then((fd) => new FileHandle(fd)),
  };
  return fs;
}
    const fs = makeFs({ fs: (...a) => host.fs(...a), fsConstants: () => host.fsConstants(), Buffer: builtins.buffer().Buffer, Readable: builtins.stream().Readable, Writable: builtins.stream().Writable, nextTick: (fn) => queueMicrotask(fn) });
    fs.default = fs;
    return fs;
  });
  builtins['fs/promises'] = memo(() => {
    const p = { ...builtins.fs().promises };
    p.default = p;
    return p;
  });
