/// Numeric flags use the operating system's values. In particular,
/// O_CREAT alone never implies O_TRUNC and O_EXCL only applies with O_CREAT.
pub fn file_handle_open_numeric(path: &JsString, flags: f64, mode: f64) -> JsFileHandle {
    if path.contains('\0') {
        throw_invalid_arg_value(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ", path,
        );
    }
    let received = format_number(flags);
    if !flags.is_finite() || flags.trunc() != flags {
        throw_out_of_range(format!("The value of \"flags\" is out of range. It must be an integer. Received {received}"));
    }
    if !(-2_147_483_648.0..=2_147_483_647.0).contains(&flags) {
        throw_out_of_range(format!("The value of \"flags\" is out of range. It must be >= -2147483648 && <= 2147483647. Received {received}"));
    }
    let flags = flags as i32;
    let mode = fs_creation_mode(mode);
    let file = open_file_numeric(path, flags, mode).unwrap_or_else(|error| throw_fs_error("open", path, error));
    file_handle_register(file)
}

#[cfg(unix)]
fn open_file_numeric(path: &JsString, flags: i32, mode: u32) -> std::io::Result<std::fs::File> {
    use rustix::fs::{Mode, OFlags, open};
    // rustix owns the descriptor; conversion to File transfers ownership
    // through safe APIs. Match Node's non-inheritable descriptors.
    let flags = OFlags::from_bits_retain(flags as u32) | OFlags::CLOEXEC;
    open(path.as_ref(), flags, Mode::from_bits_truncate(mode))
        .map(std::fs::File::from).map_err(std::io::Error::from)
}

#[cfg(not(unix))]
fn open_file_numeric(path: &JsString, flags: i32, _mode: u32) -> std::io::Result<std::fs::File> {
    // libuv's Windows O_* values use CRT bits; OpenOptions owns the HANDLE.
    let mut options = std::fs::OpenOptions::new();
    match flags & 3 {
        0 => { options.read(true); }
        1 => { options.write(true); }
        2 => { options.read(true).write(true); }
        _ => return Err(std::io::Error::from_raw_os_error(87)),
    }
    let create = flags & 256 != 0;
    options.create(create).create_new(create && flags & 1024 != 0)
        .truncate(flags & 512 != 0).append(flags & 8 != 0);
    options.open(path.as_ref())
}
