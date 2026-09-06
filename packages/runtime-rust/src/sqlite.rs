// SQLite kernel (feature `sqlite`): one engine behind the island's
// `bun:sqlite` facade (and, later, the `node:sqlite` one and the static
// lowerings). rusqlite with the bundled amalgamation — the C compiles
// inside cargo exactly like `ring`'s; the program TU stays
// forbid(unsafe_code).
//
// Connections live in a thread-local table keyed by a small integer the
// facades hold; a statement is (connection, SQL) and runs through
// rusqlite's prepared-statement cache, so the facade's `Statement`
// object never pins a borrow of the connection across engine calls.
// Every failure throws a JsError named SQLiteError carrying Bun's
// `code` (the extended result code's name).

use rusqlite::types::Value as SqliteNative;

thread_local! {
    static SQLITE_CONNECTIONS: RefCell<HashMap<u32, rusqlite::Connection>> = RefCell::new(HashMap::new());
    static SQLITE_NEXT_ID: Cell<u32> = const { Cell::new(1) };
}

/// One SQLite value, engine-neutral: the island host converts to and
/// from engine values on both sides of the bridge.
#[derive(Clone, Debug)]
pub enum SqliteValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// Bound parameters: `?` positionals or `$name`/`:name`/`@name` keys.
pub enum SqliteParams {
    Positional(Vec<SqliteValue>),
    Named(Vec<(String, SqliteValue)>),
}

fn sqlite_code_name(code: i32) -> String {
    let primary = match code & 0xff {
        1 => "SQLITE_ERROR",
        2 => "SQLITE_INTERNAL",
        3 => "SQLITE_PERM",
        4 => "SQLITE_ABORT",
        5 => "SQLITE_BUSY",
        6 => "SQLITE_LOCKED",
        7 => "SQLITE_NOMEM",
        8 => "SQLITE_READONLY",
        9 => "SQLITE_INTERRUPT",
        10 => "SQLITE_IOERR",
        11 => "SQLITE_CORRUPT",
        12 => "SQLITE_NOTFOUND",
        13 => "SQLITE_FULL",
        14 => "SQLITE_CANTOPEN",
        15 => "SQLITE_PROTOCOL",
        16 => "SQLITE_EMPTY",
        17 => "SQLITE_SCHEMA",
        18 => "SQLITE_TOOBIG",
        19 => "SQLITE_CONSTRAINT",
        20 => "SQLITE_MISMATCH",
        21 => "SQLITE_MISUSE",
        22 => "SQLITE_NOLFS",
        23 => "SQLITE_AUTH",
        24 => "SQLITE_FORMAT",
        25 => "SQLITE_RANGE",
        26 => "SQLITE_NOTADB",
        27 => "SQLITE_NOTICE",
        28 => "SQLITE_WARNING",
        _ => "SQLITE_ERROR",
    };
    let extended = match code {
        275 => "_CHECK",
        531 => "_COMMITHOOK",
        787 => "_FOREIGNKEY",
        1043 => "_FUNCTION",
        1299 => "_NOTNULL",
        1555 => "_PRIMARYKEY",
        1811 => "_TRIGGER",
        2067 => "_UNIQUE",
        2323 => "_VTAB",
        2579 => "_ROWID",
        2835 => "_PINNED",
        3091 => "_DATATYPE",
        261 => "_RECOVERY",
        517 => "_SNAPSHOT",
        773 => "_TIMEOUT",
        262 => "_SHAREDCACHE",
        518 => "_VTAB",
        264 => "_RECOVERY",
        520 => "_CANTLOCK",
        776 => "_ROLLBACK",
        1032 => "_DBMOVED",
        1288 => "_CANTINIT",
        1544 => "_DIRECTORY",
        270 => "_NOTEMPDIR",
        526 => "_ISDIR",
        782 => "_FULLPATH",
        1038 => "_CONVPATH",
        1294 => "_DIRTYWAL",
        1550 => "_SYMLINK",
        _ => "",
    };
    format!("{primary}{extended}")
}

/// Bun's SQLiteError shape: the engine's message, `code` = the extended
/// result code's name (`SQLITE_CONSTRAINT_UNIQUE`); the facade adds the
/// numeric `errno` from the same name.
fn sqlite_throw(error: rusqlite::Error) -> ! {
    let (code, message) = match &error {
        rusqlite::Error::SqliteFailure(failure, message) => (
            failure.extended_code,
            message.clone().unwrap_or_else(|| failure.to_string()),
        ),
        rusqlite::Error::SqlInputError { error, msg, .. } => (error.extended_code, msg.clone()),
        rusqlite::Error::InvalidParameterName(name) => (25, format!("Unknown parameter \"{name}\"")),
        rusqlite::Error::InvalidParameterCount(expected, got) => {
            (25, format!("Expected {expected} values, got {got}"))
        }
        other => (1, other.to_string()),
    };
    sqlite_throw_named(&sqlite_code_name(code), message)
}

fn sqlite_throw_named(code: &str, message: String) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "SQLiteError".to_owned(),
        message,
        code: Some(code.to_owned()),
        cause: None,
        dom: None,
    })
}

fn sqlite_with_connection<T>(id: f64, body: impl FnOnce(&rusqlite::Connection) -> T) -> T {
    let key = if id.is_finite() && id >= 0.0 { id as u32 } else { 0 };
    SQLITE_CONNECTIONS.with(|table| {
        let table = table.borrow();
        match table.get(&key) {
            Some(connection) => body(connection),
            None => sqlite_throw_named("SQLITE_MISUSE", "Cannot use a closed database".to_owned()),
        }
    })
}

/// `new Database(filename, flags)`: Bun's flag bits (READONLY 1,
/// READWRITE 2, CREATE 4); ":memory:" and "" open an in-memory database.
pub fn sqlite_open(filename: &str, flags: f64) -> f64 {
    let bits = flags as i64;
    let mut open = rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX | rusqlite::OpenFlags::SQLITE_OPEN_URI;
    if bits & 1 != 0 {
        open |= rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY;
    } else {
        if bits & 2 != 0 {
            open |= rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE;
        }
        if bits & 4 != 0 {
            open |= rusqlite::OpenFlags::SQLITE_OPEN_CREATE;
        }
        if bits & 6 == 0 {
            open |= rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE;
        }
    }
    let path = if filename.is_empty() { ":memory:" } else { filename };
    let connection = match rusqlite::Connection::open_with_flags(path, open) {
        Ok(connection) => connection,
        Err(error) => sqlite_throw(error),
    };
    let id = SQLITE_NEXT_ID.with(|next| {
        let id = next.get();
        next.set(id + 1);
        id
    });
    SQLITE_CONNECTIONS.with(|table| {
        table.borrow_mut().insert(id, connection);
    });
    f64::from(id)
}

/// `db.close()`: a second close is a no-op, as in Bun.
pub fn sqlite_close(id: f64) {
    let key = if id.is_finite() && id >= 0.0 { id as u32 } else { 0 };
    let connection = SQLITE_CONNECTIONS.with(|table| table.borrow_mut().remove(&key));
    if let Some(connection) = connection
        && let Err((_, error)) = connection.close()
    {
        sqlite_throw(error);
    }
}

/// `db.exec(sql)` — every statement in the text, no bindings.
pub fn sqlite_exec(id: f64, sql: &str) {
    sqlite_with_connection(id, |connection| {
        if let Err(error) = connection.execute_batch(sql) {
            sqlite_throw(error);
        }
    });
}

fn sqlite_bind(statement: &mut rusqlite::Statement<'_>, params: &SqliteParams) -> rusqlite::Result<()> {
    statement.clear_bindings();
    match params {
        SqliteParams::Positional(values) => {
            for (index, value) in values.iter().enumerate() {
                statement.raw_bind_parameter(index + 1, sqlite_native(value))?;
            }
        }
        SqliteParams::Named(entries) => {
            for (name, value) in entries {
                let mut index = statement.parameter_index(name)?;
                for prefix in ["$", ":", "@"] {
                    if index.is_some() {
                        break;
                    }
                    index = statement.parameter_index(&format!("{prefix}{name}"))?;
                }
                let Some(index) = index else {
                    return Err(rusqlite::Error::InvalidParameterName(name.clone()));
                };
                statement.raw_bind_parameter(index, sqlite_native(value))?;
            }
        }
    }
    Ok(())
}

fn sqlite_native(value: &SqliteValue) -> SqliteNative {
    match value {
        SqliteValue::Null => SqliteNative::Null,
        SqliteValue::Integer(value) => SqliteNative::Integer(*value),
        SqliteValue::Real(value) => SqliteNative::Real(*value),
        SqliteValue::Text(value) => SqliteNative::Text(value.clone()),
        SqliteValue::Blob(value) => SqliteNative::Blob(value.clone()),
    }
}

fn sqlite_value_of(value: rusqlite::types::ValueRef<'_>) -> SqliteValue {
    match value {
        rusqlite::types::ValueRef::Null => SqliteValue::Null,
        rusqlite::types::ValueRef::Integer(value) => SqliteValue::Integer(value),
        rusqlite::types::ValueRef::Real(value) => SqliteValue::Real(value),
        rusqlite::types::ValueRef::Text(bytes) => SqliteValue::Text(String::from_utf8_lossy(bytes).into_owned()),
        rusqlite::types::ValueRef::Blob(bytes) => SqliteValue::Blob(bytes.to_vec()),
    }
}

/// `statement.run(...)`: steps the statement to completion (a SELECT's
/// rows are discarded, as in Bun) and answers (changes, lastInsertRowid).
pub fn sqlite_run(id: f64, sql: &str, params: &SqliteParams) -> (f64, i64) {
    sqlite_with_connection(id, |connection| {
        let outcome = (|| -> rusqlite::Result<()> {
            let mut statement = connection.prepare_cached(sql)?;
            sqlite_bind(&mut statement, params)?;
            let mut rows = statement.raw_query();
            while rows.next()?.is_some() {}
            Ok(())
        })();
        if let Err(error) = outcome {
            sqlite_throw(error);
        }
        (connection.changes() as f64, connection.last_insert_rowid())
    })
}

/// `statement.all/get/values(...)`: the column names and up to `limit`
/// rows (0 = every row).
pub fn sqlite_rows(id: f64, sql: &str, params: &SqliteParams, limit: usize) -> (Vec<String>, Vec<Vec<SqliteValue>>) {
    sqlite_with_connection(id, |connection| {
        let outcome = (|| -> rusqlite::Result<(Vec<String>, Vec<Vec<SqliteValue>>)> {
            let mut statement = connection.prepare_cached(sql)?;
            let columns: Vec<String> = statement.column_names().iter().map(|name| (*name).to_owned()).collect();
            sqlite_bind(&mut statement, params)?;
            let width = columns.len();
            let mut rows = statement.raw_query();
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let mut values = Vec::with_capacity(width);
                for index in 0..width {
                    values.push(sqlite_value_of(row.get_ref(index)?));
                }
                out.push(values);
                if limit != 0 && out.len() >= limit {
                    break;
                }
            }
            Ok((columns, out))
        })();
        match outcome {
            Ok(result) => result,
            Err(error) => sqlite_throw(error),
        }
    })
}

/// `statement.columnNames` — the prepared statement's column names.
pub fn sqlite_columns(id: f64, sql: &str) -> Vec<String> {
    sqlite_with_connection(id, |connection| match connection.prepare_cached(sql) {
        Ok(statement) => statement.column_names().iter().map(|name| (*name).to_owned()).collect(),
        Err(error) => sqlite_throw(error),
    })
}

/// `statement.paramsCount`.
pub fn sqlite_params_count(id: f64, sql: &str) -> f64 {
    sqlite_with_connection(id, |connection| match connection.prepare_cached(sql) {
        Ok(statement) => statement.parameter_count() as f64,
        Err(error) => sqlite_throw(error),
    })
}

/// `db.serialize()` — the main database as an SQLite file image.
pub fn sqlite_serialize(id: f64) -> Vec<u8> {
    sqlite_with_connection(id, |connection| match connection.serialize(rusqlite::MAIN_DB) {
        Ok(data) => data.to_vec(),
        Err(error) => sqlite_throw(error),
    })
}
