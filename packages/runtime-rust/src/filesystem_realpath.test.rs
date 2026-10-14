#[test]
fn realpath_matches_node_for_an_existing_file() {
    let name = format!(
        "scriptc-realpath-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let path = std::env::temp_dir().join(name);
    std::fs::write(&path, b"realpath").unwrap();
    let executable = std::env::var_os("SCRIPTC_NODE_ORACLE").unwrap_or_else(|| "node".into());
    let expected = std::process::Command::new(executable)
        .args([
            "-e",
            "console.log(require('node:fs').realpathSync(process.argv[1]))",
        ])
        .arg(&path)
        .output()
        .unwrap();
    let actual = fs_realpath(&string(&path.to_string_lossy()));
    std::fs::remove_file(&path).unwrap();
    assert!(expected.status.success());
    assert_eq!(
        actual.as_ref(),
        String::from_utf8(expected.stdout)
            .unwrap()
            .trim_end_matches(['\r', '\n'])
    );
}

#[cfg(windows)]
#[test]
fn realpath_removes_verbatim_drive_and_unc_prefixes() {
    assert_eq!(
        fs_realpath_result(std::path::Path::new(r"\\?\C:\folder\file")).as_ref(),
        r"C:\folder\file"
    );
    assert_eq!(
        fs_realpath_result(std::path::Path::new(r"\\?\UNC\server\share\file")).as_ref(),
        r"\\server\share\file"
    );
}
