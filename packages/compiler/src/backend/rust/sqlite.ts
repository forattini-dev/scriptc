import type { IrModule } from "../../ir/ir.js";
import type { RustLibCallContext, RustLibCallExpr } from "./lib-calls.js";

const USES_SQLITE = new WeakMap<IrModule, boolean>();

/** True when the lowered module calls the static `bun:sqlite` surface
 * (`sqlite.*` lib calls): the program needs the runtime's `sqlite` feature
 * and the generated binding/row helpers below. */
export function moduleUsesSqlite(mod: IrModule): boolean {
  const cached = USES_SQLITE.get(mod);
  if (cached !== undefined) return cached;
  let found = false;
  const visit = (value: unknown): void => {
    if (found || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as { kind?: unknown; fn?: unknown };
    if (node.kind === "libCall" && typeof node.fn === "string" && node.fn.startsWith("sqlite.")) {
      found = true;
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(mod.functions);
  visit(mod.globals);
  USES_SQLITE.set(mod, found);
  return found;
}

/** The program-level helpers over the generated checked-dynamic type:
 * Bun's option defaults, binding normalization (a lone array or plain object
 * argument is the binding list itself, otherwise the arguments are
 * positional), and row materialization (INTEGER as bigint under
 * safeIntegers, BLOB as Uint8Array). */
export function emitRustSqliteDefinitions(line: (value: string) => void, dyn: string): void {
  const text = [
    `fn sc_sqlite_truthy(value: &${dyn}) -> bool {`,
    `    match value { ${dyn}::Undefined | ${dyn}::Null => false, ${dyn}::Boolean(value) => *value, ${dyn}::Number(value) => *value != 0.0 && !value.is_nan(), ${dyn}::String(value) => { let text: &str = value.as_ref(); !text.is_empty() }, _ => true }`,
    `}`,
    `fn sc_sqlite_option(options: &runtime::JsMap<runtime::JsString, ${dyn}>, key: &str) -> ${dyn} {`,
    `    runtime::map_get_by(options, &runtime::string(key), |left, right| left.as_ref() == right.as_ref()).unwrap_or(${dyn}::Undefined)`,
    `}`,
    `fn sc_sqlite_open(filename: &runtime::JsString, options: &${dyn}) -> runtime::JsSqliteDb {`,
    `    match options {`,
    `        ${dyn}::Number(flags) => { let bits = *flags as i64; runtime::sqlite_db_open(filename, bits & 1 != 0, bits & 2 != 0, bits & 4 != 0, false) }`,
    `        ${dyn}::Object(map) => runtime::sqlite_db_open(`,
    `            filename,`,
    `            sc_sqlite_truthy(&sc_sqlite_option(map, "readonly")),`,
    `            !matches!(sc_sqlite_option(map, "readwrite"), ${dyn}::Boolean(false)),`,
    `            !matches!(sc_sqlite_option(map, "create"), ${dyn}::Boolean(false)),`,
    `            sc_sqlite_truthy(&sc_sqlite_option(map, "safeIntegers")),`,
    `        ),`,
    `        _ => runtime::sqlite_db_open(filename, false, true, true, false),`,
    `    }`,
    `}`,
    `fn sc_sqlite_value_in(value: &${dyn}) -> runtime::SqliteValue {`,
    `    match value {`,
    `        ${dyn}::Undefined | ${dyn}::Null => runtime::SqliteValue::Null,`,
    `        ${dyn}::Boolean(value) => runtime::SqliteValue::Integer(i64::from(*value)),`,
    `        ${dyn}::Number(value) => if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 { runtime::SqliteValue::Integer(*value as i64) } else { runtime::SqliteValue::Real(*value) },`,
    `        ${dyn}::BigInt(value) => match runtime::bigint_to_i64(value) { Some(integer) => runtime::SqliteValue::Integer(integer), None => runtime::throw_range_error("BigInt value is too big to bind as an SQLite INTEGER".to_owned()) },`,
    `        ${dyn}::String(value) => { let text: &str = value.as_ref(); runtime::SqliteValue::Text(text.to_owned()) }`,
    `        ${dyn}::Bytes(bytes) | ${dyn}::Buffer(bytes) => runtime::SqliteValue::Blob(runtime::bytes_with_read_slice(bytes, |slice| slice.map(<[u8]>::to_vec).unwrap_or_default())),`,
    `        _ => runtime::throw_type_error("Binding expected string, TypedArray, boolean, number, bigint or null".to_owned()),`,
    `    }`,
    `}`,
    `fn sc_sqlite_named(map: &runtime::JsMap<runtime::JsString, ${dyn}>) -> runtime::SqliteParams {`,
    `    let mut entries = Vec::new();`,
    `    runtime::map_iter_enter(map);`,
    `    let count = runtime::map_iter_count(map);`,
    `    let mut index = 0.0;`,
    `    while index < count {`,
    `        if runtime::map_iter_live(map, index) { let key = runtime::map_iter_key(map, index); let key: &str = key.as_ref(); entries.push((key.to_owned(), sc_sqlite_value_in(&runtime::map_iter_value(map, index)))); }`,
    `        index += 1.0;`,
    `    }`,
    `    runtime::map_iter_exit(map);`,
    `    runtime::SqliteParams::Named(entries)`,
    `}`,
    `fn sc_sqlite_params(pack: &${dyn}) -> runtime::SqliteParams {`,
    `    let ${dyn}::Array(arguments) = pack else { return runtime::SqliteParams::Positional(Vec::new()); };`,
    `    let arguments = runtime::array_values(arguments);`,
    `    if arguments.len() == 1 {`,
    `        match &arguments[0] {`,
    `            ${dyn}::Array(list) => return runtime::SqliteParams::Positional(runtime::array_values(list).iter().map(sc_sqlite_value_in).collect()),`,
    `            ${dyn}::Object(map) => return sc_sqlite_named(map),`,
    `            _ => {}`,
    `        }`,
    `    }`,
    `    runtime::SqliteParams::Positional(arguments.iter().map(sc_sqlite_value_in).collect())`,
    `}`,
    `fn sc_sqlite_value_out(value: &runtime::SqliteValue, safe: bool) -> ${dyn} {`,
    `    match value {`,
    `        runtime::SqliteValue::Null => ${dyn}::Null,`,
    `        runtime::SqliteValue::Integer(integer) => if safe { ${dyn}::BigInt(runtime::bigint_from_i64(*integer)) } else { ${dyn}::Number(*integer as f64) },`,
    `        runtime::SqliteValue::Real(real) => ${dyn}::Number(*real),`,
    `        runtime::SqliteValue::Text(text) => ${dyn}::String(runtime::string(text.as_str())),`,
    `        runtime::SqliteValue::Blob(bytes) => ${dyn}::Bytes(runtime::sqlite_blob_bytes(bytes)),`,
    `    }`,
    `}`,
    `fn sc_sqlite_row(columns: &[String], row: &[runtime::SqliteValue], safe: bool) -> ${dyn} {`,
    `    let object: runtime::JsMap<runtime::JsString, ${dyn}> = runtime::map_new();`,
    `    for (column, value) in columns.iter().zip(row) { runtime::map_set_by(&object, runtime::string(column.as_str()), sc_sqlite_value_out(value, safe), |left, right| left.as_ref() == right.as_ref()); }`,
    `    ${dyn}::Object(object)`,
    `}`,
    `fn sc_sqlite_all(statement: &runtime::JsSqliteStmt, pack: &${dyn}) -> ${dyn} {`,
    `    let safe = runtime::sqlite_stmt_safe_integers(statement);`,
    `    let (columns, rows) = runtime::sqlite_stmt_rows(statement, &sc_sqlite_params(pack), 0);`,
    `    ${dyn}::Array(runtime::array_new(rows.iter().map(|row| sc_sqlite_row(&columns, row, safe)).collect()))`,
    `}`,
    `fn sc_sqlite_get(statement: &runtime::JsSqliteStmt, pack: &${dyn}) -> ${dyn} {`,
    `    let safe = runtime::sqlite_stmt_safe_integers(statement);`,
    `    let (columns, rows) = runtime::sqlite_stmt_rows(statement, &sc_sqlite_params(pack), 1);`,
    `    rows.first().map(|row| sc_sqlite_row(&columns, row, safe)).unwrap_or(${dyn}::Null)`,
    `}`,
    `fn sc_sqlite_values(statement: &runtime::JsSqliteStmt, pack: &${dyn}) -> ${dyn} {`,
    `    let safe = runtime::sqlite_stmt_safe_integers(statement);`,
    `    let (_, rows) = runtime::sqlite_stmt_rows(statement, &sc_sqlite_params(pack), 0);`,
    `    ${dyn}::Array(runtime::array_new(rows.iter().map(|row| ${dyn}::Array(runtime::array_new(row.iter().map(|value| sc_sqlite_value_out(value, safe)).collect()))).collect()))`,
    `}`,
    `fn sc_sqlite_changes(changes: f64, rowid: i64, safe: bool) -> ${dyn} {`,
    `    let object: runtime::JsMap<runtime::JsString, ${dyn}> = runtime::map_new();`,
    `    runtime::map_set_by(&object, runtime::string("changes"), ${dyn}::Number(changes), |left, right| left.as_ref() == right.as_ref());`,
    `    runtime::map_set_by(&object, runtime::string("lastInsertRowid"), sc_sqlite_value_out(&runtime::SqliteValue::Integer(rowid), safe), |left, right| left.as_ref() == right.as_ref());`,
    `    ${dyn}::Object(object)`,
    `}`,
  ];
  for (const value of text) line(value);
}

/** `sqlite.*` lib calls over the runtime handles and the helpers above. */
export function emitRustSqliteCall(expr: RustLibCallExpr, context: RustLibCallContext): string | null {
  if (!expr.fn.startsWith("sqlite.")) return null;
  const arg = (index: number): string => {
    const value = expr.args[index];
    if (value === undefined) context.unsupported(`${expr.fn} without argument ${index}`, expr.loc);
    return context.emitExpr(value);
  };
  switch (expr.fn) {
    case "sqlite.open": return `sc_sqlite_open(&(${arg(0)}), &(${arg(1)}))`;
    case "sqlite.close": return `runtime::sqlite_db_close(&(${arg(0)}))`;
    case "sqlite.exec": return `{ runtime::sqlite_db_exec(&(${arg(0)}), &(${arg(1)})); sc_sqlite_changes(0.0, 0, false) }`;
    case "sqlite.dbRun": {
      const outcome = context.nextTemporary();
      return `{ let ${outcome} = runtime::sqlite_db_run(&(${arg(0)}), &(${arg(1)}), &sc_sqlite_params(&(${arg(2)}))); sc_sqlite_changes(${outcome}.0, ${outcome}.1, false) }`;
    }
    case "sqlite.query": return `runtime::sqlite_db_query(&(${arg(0)}), &(${arg(1)}))`;
    case "sqlite.prepare": return `runtime::sqlite_db_prepare(&(${arg(0)}), &(${arg(1)}))`;
    case "sqlite.serialize": return `runtime::sqlite_db_serialize(&(${arg(0)}))`;
    case "sqlite.loadExtension": return `runtime::sqlite_db_load_extension(&(${arg(0)}), &(${arg(1)}))`;
    case "sqlite.all": return `sc_sqlite_all(&(${arg(0)}), &(${arg(1)}))`;
    case "sqlite.get": return `sc_sqlite_get(&(${arg(0)}), &(${arg(1)}))`;
    case "sqlite.values": return `sc_sqlite_values(&(${arg(0)}), &(${arg(1)}))`;
    case "sqlite.stmtRun": {
      const statement = context.nextTemporary();
      const outcome = context.nextTemporary();
      return `{ let ${statement} = ${arg(0)}; let ${outcome} = runtime::sqlite_stmt_run(&${statement}, &sc_sqlite_params(&(${arg(1)}))); sc_sqlite_changes(${outcome}.0, ${outcome}.1, runtime::sqlite_stmt_safe_integers(&${statement})) }`;
    }
    case "sqlite.safeIntegers": return `runtime::sqlite_stmt_set_safe_integers(&(${arg(0)}), ${arg(1)})`;
    default: return null;
  }
}
