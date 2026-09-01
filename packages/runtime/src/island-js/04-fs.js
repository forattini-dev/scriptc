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
  const call = env.fs;
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
  const sync = {
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
    openSync: () => {
      throw new Error("fs.openSync is not available in the scriptc island (whole-file reads/writes only)");
    },
    closeSync: () => undefined,
    readSync: () => {
      throw new Error("fs.readSync is not available in the scriptc island (whole-file reads/writes only)");
    },
    writeSync: () => {
      throw new Error("fs.writeSync is not available in the scriptc island (whole-file reads/writes only)");
    },
    read: () => {
      throw new Error("fs.read is not available in the scriptc island (whole-file reads/writes only)");
    },
    open: () => {
      throw new Error("fs.open is not available in the scriptc island (whole-file reads/writes only)");
    },
    unwatchFile: () => undefined,
  };
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
    open: () => {
      return Promise.reject(new Error("fs.promises.open is not available in the scriptc island (whole-file reads/writes only)"));
    },
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
