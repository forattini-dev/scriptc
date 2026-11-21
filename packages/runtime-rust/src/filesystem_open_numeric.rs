/// Open flag values follow the binary's target OS, not the compiler host.
pub fn fs_open_flag_constant(name: &JsString) -> f64 {
    let name = name.to_utf8_lossy();
    #[cfg(unix)]
    {
        use rustix::fs::OFlags;
        let flag = match name {
            "O_RDONLY" => OFlags::RDONLY, "O_WRONLY" => OFlags::WRONLY,
            "O_RDWR" => OFlags::RDWR, "O_CREAT" => OFlags::CREATE,
            "O_EXCL" => OFlags::EXCL, "O_TRUNC" => OFlags::TRUNC,
            "O_APPEND" => OFlags::APPEND, "O_NOFOLLOW" => OFlags::NOFOLLOW,
            _ => panic!("unknown fs open constant"),
        };
        f64::from(flag.bits())
    }
    #[cfg(not(unix))]
    {
        match name {
            "O_RDONLY" => 0.0, "O_WRONLY" => 1.0, "O_RDWR" => 2.0,
            "O_CREAT" => 256.0, "O_EXCL" => 1024.0, "O_TRUNC" => 512.0,
            "O_APPEND" => 8.0, "O_NOFOLLOW" => 0.0,
            _ => panic!("unknown fs open constant"),
        }
    }
}

/// Numeric flags use the operating system's values. In particular,
/// O_CREAT alone never implies O_TRUNC and O_EXCL only applies with O_CREAT.
pub fn file_handle_open_numeric(path: &JsString, flags: f64, mode: f64) -> JsFileHandle {
    file_handle_register(fs_open_numeric_file(path, flags, mode))
}

pub fn file_handle_open_numeric_promise(
    path: &JsString,
    flags: f64,
    mode: f64,
) -> JsPromise<JsFileHandle> {
    let path = path.clone();
    promise_from_sync(move || file_handle_open_numeric(&path, flags, mode))
}

/// Synchronous descriptor variant shares the same OS flag and mode handling.
pub fn fs_open_numeric(path: &JsString, flags: f64, mode: f64) -> f64 {
    #[cfg(not(unix))]
    if flags.is_finite() && flags.fract() == 0.0 && (i32::MIN as f64..=i32::MAX as f64).contains(&flags)
        && (flags as i32) & !(3 | 8 | 256 | 512 | 1024) != 0
    {
        throw_type_error("scriptc: unsupported numeric open flags on this platform".into());
    }
    let file = fs_open_numeric_file(path, flags, mode);
    let id = file_id(&file);
    OPEN_FILES.with(|files| {
        let previous = files.borrow_mut().insert(id, file);
        assert!(previous.is_none(), "scriptc: duplicate open file descriptor");
    });
    f64::from(id)
}

fn fs_open_numeric_file(path: &JsString, flags: f64, mode: f64) -> std::fs::File {
    if path.contains('\0') {
        throw_invalid_arg_value(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ",
            path,
        );
    }
    if !path.is_well_formed() {
        throw_type_error("scriptc: lone UTF-16 open paths are not ported".into());
    }
    let received = format_number(flags);
    if !flags.is_finite() || flags.trunc() != flags {
        throw_out_of_range(format!(
            "The value of \"flags\" is out of range. It must be an integer. Received {received}"
        ));
    }
    if !(-2_147_483_648.0..=2_147_483_647.0).contains(&flags) {
        throw_out_of_range(format!(
            "The value of \"flags\" is out of range. It must be >= -2147483648 && <= 2147483647. Received {received}"
        ));
    }
    let flags = flags as i32;
    let mode = fs_creation_mode(mode);
    open_file_numeric(path, flags, mode)
        .unwrap_or_else(|error| throw_fs_error("open", path, error))
}

fn fs_set_creation_mode(options: &mut std::fs::OpenOptions, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.attributes(if mode & 0o200 == 0 { 1 } else { 0x80 });
    }
    #[cfg(all(not(unix), not(windows)))]
    let _ = (options, mode);
}

#[cfg(unix)]
fn open_file_numeric(path: &JsString, flags: i32, mode: u32) -> std::io::Result<std::fs::File> {
    use rustix::fs::{Mode, OFlags, RawMode, open};
    // rustix owns the descriptor; conversion to File transfers ownership
    // through safe APIs. Match Node's non-inheritable descriptors.
    let flags = OFlags::from_bits_retain(flags as u32) | OFlags::CLOEXEC;
    open(
        path.to_utf8_lossy(),
        flags,
        Mode::from_raw_mode(mode as RawMode),
    )
    .map(std::fs::File::from)
    .map_err(std::io::Error::from)
}

#[cfg(not(unix))]
fn open_file_numeric(path: &JsString, flags: i32, _mode: u32) -> std::io::Result<std::fs::File> {
    // libuv's Windows O_* values use CRT bits; OpenOptions owns the HANDLE.
    let mut options = std::fs::OpenOptions::new();
    match flags & 3 {
        0 => {
            options.read(true);
        }
        1 => {
            options.write(true);
        }
        2 => {
            options.read(true).write(true);
        }
        _ => return Err(std::io::Error::from_raw_os_error(87)),
    }
    let create = flags & 256 != 0;
    options
        .create(create)
        .create_new(create && flags & 1024 != 0)
        .truncate(flags & 512 != 0)
        .append(flags & 8 != 0);
    if create {
        fs_set_creation_mode(&mut options, _mode);
    }
    let file = options.open(path.to_utf8_lossy())?;
    #[cfg(windows)]
    if create && flags & 512 != 0 {
        let mut permissions = file.metadata()?.permissions();
        permissions.set_readonly(_mode & 0o200 == 0);
        file.set_permissions(permissions)?;
    }
    Ok(file)
}
