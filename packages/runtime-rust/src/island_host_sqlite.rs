// `host.sqlite(op, ...)` — the island's bridge to the SQLite kernel
// (sqlite.rs). Values cross as engine values, not JSON: integers may be
// bigint (safeIntegers), blobs are Uint8Array, and null stays null.
// Rows come back as `[columns, [[value, ...], ...]]`; the facade shapes
// objects from the column list itself.

fn island_sqlite_param_of(value: &JsValue, context: &mut Context) -> JsResult<SqliteValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(SqliteValue::Null);
    }
    if let Some(number) = value.as_number() {
        return Ok(if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_992.0 {
            SqliteValue::Integer(number as i64)
        } else {
            SqliteValue::Real(number)
        });
    }
    if let Some(flag) = value.as_boolean() {
        return Ok(SqliteValue::Integer(i64::from(flag)));
    }
    if let Some(text) = value.as_string() {
        return Ok(SqliteValue::Text(text.to_std_string_lossy()));
    }
    if let Some(big) = value.as_bigint() {
        return match big.to_string_radix(10).parse::<i64>() {
            Ok(integer) => Ok(SqliteValue::Integer(integer)),
            Err(_) => Err(boa_engine::JsNativeError::range()
                .with_message("BigInt value is out of range for a 64-bit SQLite integer")
                .into()),
        };
    }
    if let Some(object) = value.as_object()
        && let Ok(array) = BoaJsUint8Array::from_object(object.clone())
    {
        return Ok(SqliteValue::Blob(array.to_vec(context)?));
    }
    Err(boa_engine::JsNativeError::typ()
        .with_message("Binding value must be a string, number, bigint, boolean, null, or Uint8Array")
        .into())
}

fn island_sqlite_params_of(value: &JsValue, context: &mut Context) -> JsResult<SqliteParams> {
    let Some(object) = value.as_object() else {
        return Ok(SqliteParams::Positional(Vec::new()));
    };
    if let Ok(array) = BoaJsArray::from_object(object.clone()) {
        let length = array.length(context)? as usize;
        let mut values = Vec::with_capacity(length);
        for index in 0..length {
            let item = array.get(index as u64, context)?;
            values.push(island_sqlite_param_of(&item, context)?);
        }
        return Ok(SqliteParams::Positional(values));
    }
    let mut entries = Vec::new();
    for key in object.own_property_keys(context)? {
        let name = match &key {
            boa_engine::property::PropertyKey::String(name) => name.to_std_string_lossy(),
            boa_engine::property::PropertyKey::Index(index) => index.get().to_string(),
            boa_engine::property::PropertyKey::Symbol(_) => continue,
        };
        let item = object.get(key, context)?;
        entries.push((name, island_sqlite_param_of(&item, context)?));
    }
    Ok(SqliteParams::Named(entries))
}

fn island_sqlite_value(value: &SqliteValue, safe_integers: bool, context: &mut Context) -> JsResult<JsValue> {
    Ok(match value {
        SqliteValue::Null => JsValue::null(),
        SqliteValue::Integer(integer) => {
            if safe_integers {
                JsValue::from(boa_engine::JsBigInt::from(*integer))
            } else {
                JsValue::from(*integer as f64)
            }
        }
        SqliteValue::Real(real) => JsValue::from(*real),
        SqliteValue::Text(text) => JsValue::from(boa_engine::JsString::from(text.as_str())),
        SqliteValue::Blob(bytes) => BoaJsUint8Array::from_iter(bytes.iter().copied(), context)?.into(),
    })
}

fn island_sqlite_strings(names: &[String], context: &mut Context) -> JsValue {
    BoaJsArray::from_iter(
        names.iter().map(|name| JsValue::from(boa_engine::JsString::from(name.as_str()))),
        context,
    )
    .into()
}

fn island_host_sqlite(
    _this: &JsValue,
    arguments: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    let operation = island_host_arg_string(arguments, 0, context)?;
    let number = |index: usize, context: &mut Context| island_host_arg_number(arguments, index, context);
    match operation.as_str() {
        "open" => {
            let filename = island_host_arg_string(arguments, 1, context)?;
            let flags = number(2, context)?;
            Ok(JsValue::from(island_host_run(|| sqlite_open(&filename, flags), context)?))
        }
        "close" => {
            let id = number(1, context)?;
            island_host_run(|| sqlite_close(id), context)?;
            Ok(JsValue::undefined())
        }
        "exec" => {
            let id = number(1, context)?;
            let sql = island_host_arg_string(arguments, 2, context)?;
            island_host_run(|| sqlite_exec(id, &sql), context)?;
            Ok(JsValue::undefined())
        }
        "run" => {
            let id = number(1, context)?;
            let sql = island_host_arg_string(arguments, 2, context)?;
            let params = island_sqlite_params_of(&island_host_arg(arguments, 3), context)?;
            let safe_integers = number(4, context)? != 0.0;
            let (changes, rowid) = island_host_run(|| sqlite_run(id, &sql, &params), context)?;
            let rowid = island_sqlite_value(&SqliteValue::Integer(rowid), safe_integers, context)?;
            Ok(BoaJsArray::from_iter([JsValue::from(changes), rowid], context).into())
        }
        "rows" => {
            let id = number(1, context)?;
            let sql = island_host_arg_string(arguments, 2, context)?;
            let params = island_sqlite_params_of(&island_host_arg(arguments, 3), context)?;
            let safe_integers = number(4, context)? != 0.0;
            let limit = number(5, context)?.max(0.0) as usize;
            let (columns, rows) = island_host_run(|| sqlite_rows(id, &sql, &params, limit), context)?;
            let mut out = Vec::with_capacity(rows.len());
            for row in &rows {
                let mut values = Vec::with_capacity(row.len());
                for value in row {
                    values.push(island_sqlite_value(value, safe_integers, context)?);
                }
                out.push(JsValue::from(BoaJsArray::from_iter(values, context)));
            }
            let columns = island_sqlite_strings(&columns, context);
            let rows = JsValue::from(BoaJsArray::from_iter(out, context));
            Ok(BoaJsArray::from_iter([columns, rows], context).into())
        }
        "columns" => {
            let id = number(1, context)?;
            let sql = island_host_arg_string(arguments, 2, context)?;
            let columns = island_host_run(|| sqlite_columns(id, &sql), context)?;
            Ok(island_sqlite_strings(&columns, context))
        }
        "paramsCount" => {
            let id = number(1, context)?;
            let sql = island_host_arg_string(arguments, 2, context)?;
            Ok(JsValue::from(island_host_run(|| sqlite_params_count(id, &sql), context)?))
        }
        "serialize" => {
            let id = number(1, context)?;
            let bytes = island_host_run(|| sqlite_serialize(id), context)?;
            Ok(BoaJsUint8Array::from_iter(bytes.iter().copied(), context)?.into())
        }
        _ => Err(boa_engine::JsNativeError::reference()
            .with_message("unknown island sqlite op")
            .into()),
    }
}
