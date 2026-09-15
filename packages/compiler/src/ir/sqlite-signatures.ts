import { BOOL, BYTES_U8, DYN, SQLITE_DB_T, SQLITE_STMT_T, STRING, VOID } from "./type-constants.js";

export type IrSqliteLibFn =
  /** `new Database(filename, options)` under --target bun in static builds
   * (Rust native, feature `sqlite`): filename, then readonly / readwrite /
   * create / safeIntegers already defaulted the way Bun reads them (only an
   * explicit `false` turns readwrite or create off). Throws SQLiteError. */
  | "sqlite.open"
  /** `db.close()`: idempotent. */
  | "sqlite.close"
  /** `db.exec(sql)` with no bindings. Throws SQLiteError. */
  | "sqlite.exec"
  /** `db.run(sql, ...bindings)`: the bindings arrive as one checked-dynamic
   * value (a positional array or a named-parameter object); the result is
   * Bun's `{ changes, lastInsertRowid }` as a checked-dynamic object. */
  | "sqlite.dbRun"
  /** `db.query(sql)`: the statement cached per SQL text. */
  | "sqlite.query"
  /** `db.prepare(sql)`: a fresh statement. */
  | "sqlite.prepare"
  /** `db.serialize()`: the database image as Buffer bytes. */
  | "sqlite.serialize"
  /** `db.loadExtension(path)`: always throws in a compiled binary. */
  | "sqlite.loadExtension"
  /** `statement.all/get/values/run(...bindings)`: bindings as in dbRun; rows
   * are checked-dynamic objects (all/get, get answering null past the last
   * row) or arrays (values). INTEGER columns read as bigint under
   * safeIntegers, BLOBs as Uint8Array. */
  | "sqlite.all"
  | "sqlite.get"
  | "sqlite.values"
  | "sqlite.stmtRun"
  /** `statement.safeIntegers(toggle)`. */
  | "sqlite.safeIntegers";

export const SQLITE_LIB_FN_SIGS = {
  "sqlite.open": { argTypes: [STRING, DYN], result: SQLITE_DB_T },
  "sqlite.close": { argTypes: [SQLITE_DB_T], result: VOID },
  "sqlite.exec": { argTypes: [SQLITE_DB_T, STRING], result: VOID },
  "sqlite.dbRun": { argTypes: [SQLITE_DB_T, STRING, DYN], result: DYN },
  "sqlite.query": { argTypes: [SQLITE_DB_T, STRING], result: SQLITE_STMT_T },
  "sqlite.prepare": { argTypes: [SQLITE_DB_T, STRING], result: SQLITE_STMT_T },
  "sqlite.serialize": { argTypes: [SQLITE_DB_T], result: BYTES_U8 },
  "sqlite.loadExtension": { argTypes: [SQLITE_DB_T, STRING], result: VOID },
  "sqlite.all": { argTypes: [SQLITE_STMT_T, DYN], result: DYN },
  "sqlite.get": { argTypes: [SQLITE_STMT_T, DYN], result: DYN },
  "sqlite.values": { argTypes: [SQLITE_STMT_T, DYN], result: DYN },
  "sqlite.stmtRun": { argTypes: [SQLITE_STMT_T, DYN], result: DYN },
  "sqlite.safeIntegers": { argTypes: [SQLITE_STMT_T, BOOL], result: VOID },
};

/** The sqlite lib calls that can throw (every one except close/safeIntegers). */
export const SQLITE_MAY_THROW_LIB_FNS: readonly IrSqliteLibFn[] = [
  "sqlite.open", "sqlite.exec", "sqlite.dbRun", "sqlite.query", "sqlite.prepare", "sqlite.serialize",
  "sqlite.loadExtension", "sqlite.all", "sqlite.get", "sqlite.values", "sqlite.stmtRun",
];
