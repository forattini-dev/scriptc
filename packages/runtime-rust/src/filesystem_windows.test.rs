#[cfg(windows)]
#[test]
fn windows_creation_mode_chmod_and_access_use_readonly_attributes() {
    let prefix = format!("{}\\scriptc-win-mode-", std::env::temp_dir().display());
    let directory = fs_mkdtemp(&string(&prefix));
    let path = string(&format!("{}\\value.txt", directory));
    fs_write_file_mode(&path, &string("first"), 0o600 as f64);
    fs_access(&path, 2.0);
    fs_write_file_mode(&path, &string("second"), 0o400 as f64);
    assert!(
        std::fs::metadata(path.to_utf8_lossy())
            .unwrap()
            .permissions()
            .readonly()
    );
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fs_access(&path, 2.0)))
        .unwrap_err();
    let error = caught_from_panic(payload);
    assert_eq!(caught_error_code(&error).as_deref(), Some("EPERM"));
    fs_chmod(&path, 0o600 as f64);
    fs_access(&path, 2.0);
    assert_eq!(fs_read_file(&path).to_utf8_lossy(), "second");
    fs_chown(&string(&format!("{}\\missing", directory)), -1.0, -1.0);
    fs_rm_options(&directory, true, true);
    drop((path, directory, error));
    finish();
    assert_eq!(live_heap_objects(), 0);
}
