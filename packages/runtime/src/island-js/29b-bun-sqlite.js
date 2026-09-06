    /* bun:sqlite over the host's SQLite kernel (the Rust runtime's
     * `sqlite` feature, rusqlite with the bundled amalgamation). Present
     * only when the host exposes the bridge — a program whose embedded
     * graph never imports bun:sqlite keeps the trap, and so does the C
     * island. The surface is Bun's: Database (query/prepare/run/exec/
     * transaction/serialize/close), Statement (all/get/values/run/
     * iterate/safeIntegers/as/columnNames/paramsCount/finalize),
     * SQLiteError with `code` and `errno`, constants. */
  if (typeof host.sqlite === 'function' && globalThis.__scr_runtime_target === 'bun') {
    const SQLITE_ERRNO = {
      SQLITE_ERROR: 1, SQLITE_INTERNAL: 2, SQLITE_PERM: 3, SQLITE_ABORT: 4, SQLITE_BUSY: 5, SQLITE_LOCKED: 6,
      SQLITE_NOMEM: 7, SQLITE_READONLY: 8, SQLITE_INTERRUPT: 9, SQLITE_IOERR: 10, SQLITE_CORRUPT: 11,
      SQLITE_NOTFOUND: 12, SQLITE_FULL: 13, SQLITE_CANTOPEN: 14, SQLITE_PROTOCOL: 15, SQLITE_EMPTY: 16,
      SQLITE_SCHEMA: 17, SQLITE_TOOBIG: 18, SQLITE_CONSTRAINT: 19, SQLITE_MISMATCH: 20, SQLITE_MISUSE: 21,
      SQLITE_NOLFS: 22, SQLITE_AUTH: 23, SQLITE_FORMAT: 24, SQLITE_RANGE: 25, SQLITE_NOTADB: 26,
      SQLITE_NOTICE: 27, SQLITE_WARNING: 28,
      SQLITE_CONSTRAINT_CHECK: 275, SQLITE_CONSTRAINT_COMMITHOOK: 531, SQLITE_CONSTRAINT_FOREIGNKEY: 787,
      SQLITE_CONSTRAINT_FUNCTION: 1043, SQLITE_CONSTRAINT_NOTNULL: 1299, SQLITE_CONSTRAINT_PRIMARYKEY: 1555,
      SQLITE_CONSTRAINT_TRIGGER: 1811, SQLITE_CONSTRAINT_UNIQUE: 2067, SQLITE_CONSTRAINT_VTAB: 2323,
      SQLITE_CONSTRAINT_ROWID: 2579, SQLITE_CONSTRAINT_PINNED: 2835, SQLITE_CONSTRAINT_DATATYPE: 3091,
      SQLITE_BUSY_RECOVERY: 261, SQLITE_BUSY_SNAPSHOT: 517, SQLITE_BUSY_TIMEOUT: 773,
      SQLITE_LOCKED_SHAREDCACHE: 262, SQLITE_LOCKED_VTAB: 518,
      SQLITE_READONLY_RECOVERY: 264, SQLITE_READONLY_CANTLOCK: 520, SQLITE_READONLY_ROLLBACK: 776,
      SQLITE_READONLY_DBMOVED: 1032, SQLITE_READONLY_CANTINIT: 1288, SQLITE_READONLY_DIRECTORY: 1544,
      SQLITE_CANTOPEN_NOTEMPDIR: 270, SQLITE_CANTOPEN_ISDIR: 526, SQLITE_CANTOPEN_FULLPATH: 782,
      SQLITE_CANTOPEN_CONVPATH: 1038, SQLITE_CANTOPEN_DIRTYWAL: 1294, SQLITE_CANTOPEN_SYMLINK: 1550,
    };
    class SQLiteError extends Error {
      constructor(message, code, errno, byteOffset) {
        super(message);
        this.name = 'SQLiteError';
        this.code = code;
        this.errno = errno;
        this.byteOffset = byteOffset;
      }
    }
    const toSQLiteError = (e) => {
      if (e instanceof SQLiteError) return e;
      if (e === null || typeof e !== 'object' || typeof e.code !== 'string' || !e.code.startsWith('SQLITE_')) return e;
      const primary = e.code.split('_').slice(0, 2).join('_');
      const errno = SQLITE_ERRNO[e.code] !== undefined ? SQLITE_ERRNO[e.code] : (SQLITE_ERRNO[primary] !== undefined ? SQLITE_ERRNO[primary] : 1);
      return new SQLiteError(e.message, e.code, errno, -1);
    };
    const sqliteCall = (...args) => {
      try {
        return host.sqlite(...args);
      } catch (e) {
        throw toSQLiteError(e);
      }
    };
    const constants = {
      SQLITE_OPEN_READONLY: 0x00000001, SQLITE_OPEN_READWRITE: 0x00000002, SQLITE_OPEN_CREATE: 0x00000004,
      SQLITE_OPEN_DELETEONCLOSE: 0x00000008, SQLITE_OPEN_EXCLUSIVE: 0x00000010, SQLITE_OPEN_AUTOPROXY: 0x00000020,
      SQLITE_OPEN_URI: 0x00000040, SQLITE_OPEN_MEMORY: 0x00000080, SQLITE_OPEN_MAIN_DB: 0x00000100,
      SQLITE_OPEN_TEMP_DB: 0x00000200, SQLITE_OPEN_TRANSIENT_DB: 0x00000400, SQLITE_OPEN_MAIN_JOURNAL: 0x00000800,
      SQLITE_OPEN_TEMP_JOURNAL: 0x00001000, SQLITE_OPEN_SUBJOURNAL: 0x00002000, SQLITE_OPEN_SUPER_JOURNAL: 0x00004000,
      SQLITE_OPEN_NOMUTEX: 0x00008000, SQLITE_OPEN_FULLMUTEX: 0x00010000, SQLITE_OPEN_SHAREDCACHE: 0x00020000,
      SQLITE_OPEN_PRIVATECACHE: 0x00040000, SQLITE_OPEN_WAL: 0x00080000, SQLITE_OPEN_NOFOLLOW: 0x01000000,
      SQLITE_OPEN_EXRESCODE: 0x02000000, SQLITE_PREPARE_PERSISTENT: 0x01, SQLITE_PREPARE_NORMALIZE: 0x02,
      SQLITE_PREPARE_NO_VTAB: 0x04, SQLITE_FCNTL_PERSIST_WAL: 10,
    };
    const toParam = (v) => {
      if (v === undefined) return null;
      if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (v instanceof Uint8Array) return v;
      if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (v instanceof ArrayBuffer) return new Uint8Array(v);
      if (typeof v === 'object' && typeof v.toString === 'function' && v instanceof Date) return v.toISOString();
      throw new TypeError('Binding value must be a string, number, bigint, boolean, null, Uint8Array, or ArrayBuffer');
    };
    const isNamedRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer) && !(v instanceof Date);
    const normalizeParams = (args) => {
      if (args.length === 1 && Array.isArray(args[0])) return args[0].map(toParam);
      if (args.length === 1 && isNamedRecord(args[0])) {
        const out = {};
        for (const key of Object.keys(args[0])) out[key] = toParam(args[0][key]);
        return out;
      }
      return args.map(toParam);
    };
    const shapeRows = (columns, rows, Class) => {
      const out = new Array(rows.length);
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const o = Class ? Object.create(Class.prototype) : {};
        for (let c = 0; c < columns.length; c++) o[columns[c]] = row[c];
        out[r] = o;
      }
      return out;
    };
    class Statement {
      constructor(db, sql, bound) {
        this._db = db;
        this._sql = sql;
        this._bound = bound;
        this._safe = db._safe;
        this._class = undefined;
        this._finalized = false;
      }
      get native() { return this; }
      get columnNames() { return sqliteCall('columns', this._db._id, this._sql); }
      get paramsCount() { return sqliteCall('paramsCount', this._db._id, this._sql); }
      toString() { return this._sql; }
      safeIntegers(enabled = true) { this._safe = !!enabled; return this; }
      as(Class) { this._class = Class; return this; }
      finalize() { this._finalized = true; }
      _params(args) { return args.length > 0 ? normalizeParams(args) : (this._bound === undefined ? [] : this._bound); }
      _rows(args, limit) {
        if (this._finalized) throw new SQLiteError('Statement has finalized', 'SQLITE_MISUSE', 21, -1);
        return sqliteCall('rows', this._db._id, this._sql, this._params(args), this._safe ? 1 : 0, limit);
      }
      all(...args) { const [columns, rows] = this._rows(args, 0); return shapeRows(columns, rows, this._class); }
      get(...args) { const [columns, rows] = this._rows(args, 1); return rows.length === 0 ? null : shapeRows(columns, rows, this._class)[0]; }
      values(...args) { return this._rows(args, 0)[1]; }
      run(...args) {
        if (this._finalized) throw new SQLiteError('Statement has finalized', 'SQLITE_MISUSE', 21, -1);
        const [changes, lastInsertRowid] = sqliteCall('run', this._db._id, this._sql, this._params(args), this._safe ? 1 : 0);
        return { changes, lastInsertRowid };
      }
      *iterate(...args) { yield* this.all(...args); }
      [Symbol.iterator]() { return this.iterate(); }
    }
    class Database {
      constructor(filename = ':memory:', options) {
        let flags;
        this._safe = false;
        this._strict = false;
        if (typeof options === 'number') {
          flags = options;
        } else {
          const o = options || {};
          this._safe = !!o.safeIntegers;
          this._strict = !!o.strict;
          if (o.readonly) flags = 1;
          else flags = (o.readwrite === false ? 0 : 2) | (o.create === false ? 0 : 4);
        }
        this.filename = filename === '' ? ':memory:' : String(filename);
        this._id = sqliteCall('open', this.filename, flags);
        this._cache = new Map();
        this._txDepth = 0;
      }
      static open(filename, options) { return new Database(filename, options); }
      static deserialize() { throw new SQLiteError('Database.deserialize is not available in a compiled binary', 'SQLITE_ERROR', 1, -1); }
      static setCustomSQLite() { return false; }
      get inTransaction() { return this._txDepth > 0; }
      query(sql) {
        let statement = this._cache.get(sql);
        if (!statement) {
          statement = new Statement(this, String(sql));
          this._cache.set(sql, statement);
        }
        return statement;
      }
      prepare(sql, params) { return new Statement(this, String(sql), params === undefined ? undefined : normalizeParams([params])); }
      run(sql, ...params) { return this.prepare(sql).run(...params); }
      exec(sql, ...params) {
        if (params.length === 0) {
          sqliteCall('exec', this._id, String(sql));
          return { changes: 0, lastInsertRowid: 0 };
        }
        return this.run(sql, ...params);
      }
      transaction(fn) {
        const db = this;
        const wrap = (mode) => (...args) => {
          const depth = db._txDepth;
          sqliteCall('exec', db._id, depth === 0 ? 'BEGIN ' + mode : 'SAVEPOINT scriptc_sp' + depth);
          db._txDepth = depth + 1;
          let result;
          try {
            result = fn(...args);
          } catch (e) {
            db._txDepth = depth;
            sqliteCall('exec', db._id, depth === 0 ? 'ROLLBACK' : 'ROLLBACK TO scriptc_sp' + depth + '; RELEASE scriptc_sp' + depth);
            throw e;
          }
          db._txDepth = depth;
          sqliteCall('exec', db._id, depth === 0 ? 'COMMIT' : 'RELEASE scriptc_sp' + depth);
          return result;
        };
        const t = wrap('');
        t.deferred = wrap('DEFERRED');
        t.immediate = wrap('IMMEDIATE');
        t.exclusive = wrap('EXCLUSIVE');
        return t;
      }
      serialize() {
        const u8 = sqliteCall('serialize', this._id);
        const Buffer = builtins.buffer().Buffer;
        return Buffer.from(u8.buffer, u8.byteOffset, u8.length);
      }
      loadExtension() { throw new SQLiteError('loadExtension is not available in a compiled binary', 'SQLITE_ERROR', 1, -1); }
      fileControl() { return 0; }
      close() {
        if (this._id < 0) return;
        const id = this._id;
        this._id = -1;
        sqliteCall('close', id);
      }
    }
    if (typeof Symbol.dispose === 'symbol') Database.prototype[Symbol.dispose] = function () { this.close(); };
    bunTrapModules['bun:sqlite'] = { __esModule: true, Database, Statement, SQLiteError, constants, default: Database };
  }
