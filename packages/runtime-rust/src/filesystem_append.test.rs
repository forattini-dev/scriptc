#[cfg(unix)]
#[test]
fn append_mode_is_creation_only_and_obeys_umask() {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let root = std::env::temp_dir().join(format!("scriptc-append-mode-{}", std::process::id()));
    std::fs::create_dir(&root).expect("fresh append fixture");
    let path = root.join("spool");
    let control = root.join("control");
    // Observe the current umask without changing process-global state.
    std::fs::OpenOptions::new().write(true).create_new(true).mode(0o666)
        .open(&control).expect("create control");
    let expected_mode = std::fs::metadata(&control).unwrap().permissions().mode() & 0o666;
    let name = string(path.to_str().expect("test path"));
    fs_append_file_mode(&name, &string("ação\n"), 0o666 as f64, false);
    let created_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(created_mode, expected_mode);
    // A known writable existing mode makes the append independent of umask.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    fs_append_file_mode(&name, &string("次\n"), 0o400 as f64, false);
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "ação\n次\n");
    std::fs::remove_dir_all(&root).expect("remove fixture");
}
