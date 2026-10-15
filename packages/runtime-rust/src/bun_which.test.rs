#[test]
fn bun_which_finds_files_without_executing_or_canonicalizing_them() {
    let root = std::env::temp_dir().join(format!("scriptc-which-native-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let suffix = if cfg!(windows) { ".cmd" } else { "" };
    let bin = root.join(format!("ação-开始{suffix}"));
    std::fs::write(&bin, "not executable program content").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let directory = root.to_str().unwrap();
    let expected = bin.to_str().unwrap().to_owned();
    assert_eq!(
        bun_which_search("ação-开始", directory, ""),
        Some(expected.clone())
    );
    assert_eq!(bun_which_search("ação-开始", "", directory), None);
    assert_eq!(
        bun_which_search(&format!("./ação-开始{suffix}"), "", directory),
        Some(expected.clone())
    );
    assert_eq!(bun_which_search(&expected, "", ""), Some(expected));
    assert_eq!(bun_which_search("missing", directory, ""), None);
    std::fs::create_dir(root.join(format!("folder{suffix}"))).unwrap();
    assert_eq!(
        bun_which_search(&format!("folder{suffix}"), directory, ""),
        None
    );
    std::fs::remove_dir_all(&root).unwrap();
}

#[cfg(unix)]
#[test]
fn bun_which_skips_permissions_and_preserves_symlink_spelling() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root =
        std::env::temp_dir().join(format!("scriptc-which-permissions-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let bin = root.join("bin");
    let link = root.join("alias");
    std::fs::write(&bin, "not launched").unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(bun_which_search("bin", root.to_str().unwrap(), ""), None);
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    symlink(&bin, &link).unwrap();
    assert_eq!(
        bun_which_search("alias", root.to_str().unwrap(), ""),
        Some(link.to_str().unwrap().to_owned())
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn bun_which_uses_windows_extension_order_and_handles_long_paths_safely() {
    let root =
        std::env::temp_dir().join(format!("scriptc-which-extensions-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    for name in ["bin", "bin.bat", "bin.cmd", "bin.exe"] {
        std::fs::write(root.join(name), "not launched").unwrap();
    }
    assert_eq!(
        bun_which_search("bin", root.to_str().unwrap(), ""),
        Some(root.join("bin.exe").to_str().unwrap().to_owned())
    );
    assert_eq!(
        bun_which_search("bin.CMD", root.to_str().unwrap(), ""),
        Some(root.join("bin.CMD").to_str().unwrap().to_owned())
    );
    assert_eq!(
        bun_which_search(&"a".repeat(32767), root.to_str().unwrap(), ""),
        None
    );
    std::fs::remove_dir_all(root).unwrap();
}
