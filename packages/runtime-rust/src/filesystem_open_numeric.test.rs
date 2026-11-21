#[cfg(unix)]
#[test]
fn numeric_exclusive_creation_has_exactly_one_concurrent_owner() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("scriptc-numeric-lock-{}", std::process::id()));
    std::fs::create_dir(&root).expect("fresh lock fixture");
    let path = root.join("owner.lock");
    let barrier = std::sync::Barrier::new(8);
    let winners = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..8).map(|_| {
            let path = &path;
            let barrier = &barrier;
            scope.spawn(move || {
                let flags = rustix::fs::OFlags::CREATE | rustix::fs::OFlags::EXCL | rustix::fs::OFlags::RDWR;
                let path = string(path.to_str().expect("test path"));
                barrier.wait();
                match open_file_numeric(&path, flags.bits() as i32, 0o600) {
                    Ok(_) => 1,
                    Err(error) => { assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists); 0 }
                }
            })
        }).collect();
        workers.into_iter().map(|worker| worker.join().expect("lock contender")).sum::<usize>()
    });
    let mode = std::fs::metadata(&path).expect("created lock").permissions().mode() & 0o777;
    std::fs::remove_file(&path).expect("remove lock");
    std::fs::remove_dir(&root).expect("remove fixture");
    assert_eq!(winners, 1);
    assert_eq!(mode & 0o177, 0, "creation must not grant permissions outside mode 0600");
}

#[cfg(unix)]
#[test]
fn numeric_no_follow_rejects_symlink_without_touching_target() {
    use std::os::unix::fs::symlink;
    let root = std::env::temp_dir().join(format!("scriptc-numeric-nofollow-{}", std::process::id()));
    std::fs::create_dir(&root).expect("fresh fixture");
    let target = root.join("target");
    let link = root.join("link");
    std::fs::write(&target, b"untouched").unwrap();
    symlink(&target, &link).unwrap();
    let flags = rustix::fs::OFlags::WRONLY | rustix::fs::OFlags::TRUNC | rustix::fs::OFlags::NOFOLLOW;
    let path = string(link.to_str().unwrap());
    assert!(open_file_numeric(&path, flags.bits() as i32, 0o600).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
    std::fs::remove_file(link).unwrap();
    std::fs::remove_file(target).unwrap();
    std::fs::remove_dir(root).unwrap();
}
