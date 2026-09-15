#[test]
fn sqlite_handles_run_query_and_cache_statements() {
    let db = sqlite_db_open(&string(":memory:"), false, true, true, false);
    sqlite_db_exec(&db, &string("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"));
    let inserted = sqlite_db_run(
        &db,
        &string("INSERT INTO t (name) VALUES (?)"),
        &SqliteParams::Positional(vec![SqliteValue::Text("a".to_owned())]),
    );
    assert_eq!(inserted, (1.0, 1));

    let first = sqlite_db_query(&db, &string("SELECT id, name FROM t"));
    let second = sqlite_db_query(&db, &string("SELECT id, name FROM t"));
    assert_eq!(first.identity(), second.identity());
    let fresh = sqlite_db_prepare(&db, &string("SELECT id, name FROM t"));
    assert_ne!(fresh.identity(), first.identity());

    let (columns, rows) = sqlite_stmt_rows(&first, &SqliteParams::Positional(Vec::new()), 0);
    assert_eq!(columns, vec!["id".to_owned(), "name".to_owned()]);
    assert_eq!(rows.len(), 1);
    assert!(matches!(rows[0][0], SqliteValue::Integer(1)));
    assert!(matches!(&rows[0][1], SqliteValue::Text(name) if name == "a"));

    assert!(!sqlite_stmt_safe_integers(&first));
    sqlite_stmt_set_safe_integers(&first, true);
    assert!(sqlite_stmt_safe_integers(&first));

    sqlite_db_close(&db);
    sqlite_db_close(&db);
}

#[test]
fn sqlite_handles_open_flags_follow_bun_defaults() {
    let path = std::env::temp_dir().join(format!("scriptc-sqlite-handles-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let file = string(path.to_string_lossy().as_ref());
    let created = sqlite_db_open(&file, false, true, true, false);
    sqlite_db_exec(&created, &string("CREATE TABLE kept (value INTEGER)"));
    sqlite_db_close(&created);

    let reopened = sqlite_db_open(&file, true, true, true, false);
    let (_, rows) = sqlite_stmt_rows(
        &sqlite_db_query(&reopened, &string("SELECT name FROM sqlite_master WHERE type = 'table'")),
        &SqliteParams::Positional(Vec::new()),
        0,
    );
    assert_eq!(rows.len(), 1);
    sqlite_db_close(&reopened);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn bigint_i64_round_trips_past_the_safe_integer_range() {
    let value = bigint_from_i64(9_007_199_254_740_993);
    assert_eq!(bigint_to_i64(&value), Some(9_007_199_254_740_993));
    let text = bigint_to_string(&value);
    let text: &str = text.as_ref();
    assert_eq!(text, "9007199254740993");
    assert_eq!(bigint_to_i64(&bigint_from_string(&string("99999999999999999999"))), None);
}
