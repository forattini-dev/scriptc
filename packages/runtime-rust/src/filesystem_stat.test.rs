#[test]
fn stat_snapshots_own_identity_and_metadata() {
    let path = std::env::temp_dir().join(format!("scriptc-stat-{}", crypto_random_uuid()));
    std::fs::write(&path, b"abc").unwrap();
    let name = string(path.to_str().unwrap());
    let first = fs_stat_sync(&name);
    let alias = first.clone();
    std::fs::write(&path, b"abcdef").unwrap();
    let second = fs_stat_sync(&name);
    assert!(first.ptr_eq(&alias));
    assert!(!first.ptr_eq(&second));
    assert_eq!(stats_size(&first), 3.0);
    assert_eq!(stats_size(&second), 6.0);
    assert!(stats_is_file(&first));
    assert!(!stats_is_directory(&first));
    assert!(!stats_is_symlink(&first));
    std::fs::remove_file(path).unwrap();
}

#[cfg(any(unix, windows))]
#[test]
fn descriptor_and_path_identity_detect_replacement() {
    let root = std::env::temp_dir().join(format!("scriptc-stat-identity-{}", crypto_random_uuid()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("lock");
    let moved = root.join("old-lock");
    std::fs::write(&path, b"old").unwrap();
    let name = string(path.to_str().unwrap());
    let fd = fs_open(&name, &string("r"));
    let before = fs_fstat(fd);
    let by_path = fs_stat_sync(&name);
    assert_eq!((stats_dev(&before), stats_ino(&before)), (stats_dev(&by_path), stats_ino(&by_path)));
    std::fs::rename(&path, &moved).unwrap();
    std::fs::write(&path, b"new").unwrap();
    let replacement = fs_stat_sync(&name);
    let still_open = fs_fstat(fd);
    assert_eq!((stats_dev(&before), stats_ino(&before)), (stats_dev(&still_open), stats_ino(&still_open)));
    assert_ne!((stats_dev(&before), stats_ino(&before)), (stats_dev(&replacement), stats_ino(&replacement)));
    fs_close(fd);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_file(moved).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn stat_paths_validate_before_os_calls() {
    for follow in [false, true] {
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            fs_stat(&string("invalid\0path"), follow);
        })).expect_err("NUL must be rejected before metadata access");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "TypeError");
        assert_eq!(caught_error_code(&caught).as_deref(), Some("ERR_INVALID_ARG_VALUE"));
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            fs_stat(&JsString::from_utf16(&[0xd800]), follow);
        })).expect_err("unrepresented paths must not be converted lossily");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "TypeError");
        assert!(caught_error_message(&caught).contains("lone UTF-16 filesystem paths"));
    }
}

#[cfg(unix)]
#[test]
fn stat_follows_links_while_lstat_snapshots_the_link() {
    let root = std::env::temp_dir().join(format!("scriptc-stat-link-{}", crypto_random_uuid()));
    std::fs::create_dir(&root).unwrap();
    let target = root.join("target");
    let link = root.join("link");
    std::fs::write(&target, b"abc").unwrap();
    std::os::unix::fs::symlink("target", &link).unwrap();
    let name = string(link.to_str().unwrap());
    assert!(stats_is_file(&fs_stat_sync(&name)));
    assert!(!stats_is_symlink(&fs_stat_sync(&name)));
    let snapshot = fs_lstat_sync(&name);
    assert!(stats_is_symlink(&snapshot));
    assert!(!stats_is_file(&snapshot));
    assert_eq!(stats_size(&snapshot), 6.0);
    std::fs::remove_file(target).unwrap();
    assert!(stats_is_symlink(&fs_lstat_sync(&name)));
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        fs_stat_sync(&name);
    })).expect_err("stat follows a broken link and must report ENOENT");
    assert_eq!(caught_error_code(&caught_from_panic(payload)).as_deref(), Some("ENOENT"));
    std::fs::remove_file(link).unwrap();
    std::fs::remove_dir(root).unwrap();
}
