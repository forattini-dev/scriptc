fn native_sqlite_option(options: &NativeValue, key: &str) -> NativeValue {
    if matches!(options, NativeValue::Undefined) {
        NativeValue::Undefined
    } else {
        native_value_get(options.clone(), runtime::string(key))
    }
}
fn native_sqlite_option_bool(options: &NativeValue, key: &str, default: bool) -> bool {
    match native_sqlite_option(options, key) {
        NativeValue::Undefined => default,
        NativeValue::Boolean(value) => value,
        _ => runtime::throw_type_error(format!("node:sqlite option {key} must be boolean")),
    }
}
fn native_node_sqlite_open(filename: runtime::JsString, options: NativeValue) -> f64 {
    let read_only = native_sqlite_option_bool(&options, "readOnly", false);
    if !native_sqlite_option_bool(&options, "open", true) {
        runtime::throw_error_code("node:sqlite open:false is not ported yet".into(), "SC1031");
    }
    let id = runtime::sqlite_open(filename.as_ref(), if read_only { 1.0 } else { 6.0 });
    match native_sqlite_option(&options, "timeout") {
        NativeValue::Undefined => {}
        NativeValue::Number(timeout) if timeout.is_finite() && timeout >= 0.0 => {
            runtime::sqlite_exec(id, &format!("PRAGMA busy_timeout = {}", timeout.trunc()));
        }
        _ => runtime::throw_type_error("node:sqlite option timeout must be a nonnegative number".into()),
    }
    if native_sqlite_option_bool(&options, "enableForeignKeyConstraints", true) {
        runtime::sqlite_exec(id, "PRAGMA foreign_keys = ON");
    }
    id
}
fn native_sqlite_parameter(value: NativeValue) -> runtime::SqliteValue {
    match value {
        NativeValue::Undefined | NativeValue::Null => runtime::SqliteValue::Null,
        NativeValue::Boolean(value) => runtime::SqliteValue::Integer(i64::from(value)),
        NativeValue::Number(value) if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 => runtime::SqliteValue::Integer(value as i64),
        NativeValue::Number(value) => runtime::SqliteValue::Real(value),
        NativeValue::BigInt(value) => runtime::bigint_to_i64(&value).map(runtime::SqliteValue::Integer).unwrap_or_else(|| runtime::throw_range_error("SQLite bigint is outside the signed 64-bit range".into())),
        NativeValue::String(value) => runtime::SqliteValue::Text(value.to_utf8_lossy().to_owned()),
        NativeValue::ArrayBuffer(value) => runtime::SqliteValue::Blob(runtime::bytes_with_read_slice(&value, |slice| slice.unwrap_or(&[]).to_vec())),
        _ => runtime::throw_type_error("Unsupported SQLite parameter type".into()),
    }
}
fn native_sqlite_parameters(values: runtime::JsArray<NativeValue>) -> runtime::SqliteParams {
    let entries = runtime::array_values(&values);
    if entries.len() == 1 && matches!(entries[0], NativeValue::Object(_) | NativeValue::Record(..)) {
        let object = entries[0].clone();
        return runtime::SqliteParams::Named(native_value_own_keys(&object).into_iter().map(|key| {
            let value = native_value_get(object.clone(), key.clone());
            (key.to_utf8_lossy().to_owned(), native_sqlite_parameter(value))
        }).collect());
    }
    runtime::SqliteParams::Positional(entries.into_iter().map(native_sqlite_parameter).collect())
}
fn native_sqlite_result_value(value: runtime::SqliteValue, safe: bool) -> NativeValue {
    match value {
        runtime::SqliteValue::Null => NativeValue::Null,
        runtime::SqliteValue::Integer(value) if safe => NativeValue::BigInt(runtime::bigint_from_i64(value)),
        runtime::SqliteValue::Integer(value) => NativeValue::Number(value as f64),
        runtime::SqliteValue::Real(value) => NativeValue::Number(value),
        runtime::SqliteValue::Text(value) => NativeValue::String(runtime::string(&value)),
        runtime::SqliteValue::Blob(value) => NativeValue::ArrayBuffer(runtime::ffi_bytes_copy_in(&value)),
    }
}
fn native_sqlite_rows(statement: f64, arguments: runtime::JsArray<NativeValue>, limit: usize) -> NativeValue {
    let params = native_sqlite_parameters(arguments);
    let (columns, rows, safe, arrays) = runtime::sqlite_statement_rows(statement, &params, limit);
    let rows = rows.into_iter().map(|row| {
        if arrays {
            NativeValue::Array(runtime::array_new(row.into_iter().map(|value| native_sqlite_result_value(value, safe)).collect()))
        } else {
            NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: columns.iter().cloned().zip(row).map(|(name, value)| (runtime::string(&name), native_sqlite_result_value(value, safe))).collect(), hash_index: NativeHashIndex::default() }))
        }
    }).collect::<Vec<_>>();
    if limit == 1 { rows.into_iter().next().unwrap_or(NativeValue::Undefined) } else { NativeValue::Array(runtime::array_new(rows)) }
}
fn native_sqlite_run(statement: f64, arguments: runtime::JsArray<NativeValue>) -> NativeValue {
    let (changes, rowid) = runtime::sqlite_statement_run(statement, &native_sqlite_parameters(arguments));
    NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: vec![(runtime::string("changes"), NativeValue::Number(changes)), (runtime::string("lastInsertRowid"), NativeValue::Number(rowid as f64))], hash_index: NativeHashIndex::default() }))
}
