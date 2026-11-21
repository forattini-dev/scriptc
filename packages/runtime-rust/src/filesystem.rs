const STDIN_FD: f64 = 0.0;

/// Node's (code, message) pair for an io error kind, shared by
/// fs_error_code and fs_error_text so the two can never drift.
fn fs_error_entry(kind: std::io::ErrorKind) -> Option<(&'static str, &'static str)> {
    use std::io::ErrorKind as Kind;
    Some(match kind {
        Kind::NotFound => ("ENOENT", "no such file or directory"),
        Kind::PermissionDenied => ("EACCES", "permission denied"),
        Kind::AlreadyExists => ("EEXIST", "file already exists"),
        Kind::InvalidInput => ("EINVAL", "invalid argument"),
        Kind::NotADirectory => ("ENOTDIR", "not a directory"),
        Kind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        Kind::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        Kind::BrokenPipe => ("EPIPE", "broken pipe"),
        Kind::AddrInUse => ("EADDRINUSE", "address already in use"),
        Kind::AddrNotAvailable => ("EADDRNOTAVAIL", "address not available"),
        Kind::ConnectionRefused => ("ECONNREFUSED", "connection refused"),
        Kind::ConnectionReset => ("ECONNRESET", "connection reset by peer"),
        Kind::TimedOut => ("ETIMEDOUT", "connection timed out"),
        _ => return None,
    })
}

fn fs_error_is_badf(error: &std::io::Error) -> bool {
    (cfg!(unix) && error.raw_os_error() == Some(9))
        || (cfg!(windows) && error.raw_os_error() == Some(6))
}

fn fs_error_is_privilege_not_held(error: &std::io::Error) -> bool {
    cfg!(windows) && error.raw_os_error() == Some(1314)
}

fn fs_error_code(error: &std::io::Error) -> &'static str {
    if fs_error_is_badf(error) {
        return "EBADF";
    }
    if fs_error_is_privilege_not_held(error) {
        return "EPERM";
    }
    fs_error_entry(error.kind()).map_or("EIO", |(code, _)| code)
}

fn fs_error_text(error: &std::io::Error) -> String {
    if fs_error_is_badf(error) {
        return "bad file descriptor".to_owned();
    }
    if fs_error_is_privilege_not_held(error) {
        return "operation not permitted".to_owned();
    }
    match fs_error_entry(error.kind()) {
        Some((_, text)) => text.to_owned(),
        None => error.to_string(),
    }
}

fn throw_fs_error(operation: &str, path: &JsString, error: std::io::Error) -> ! {
    let code = fs_error_code(&error);
    let text = fs_error_text(&error);
    throw_value(JsError {
        identity: Rc::new(()),
        name: "Error".to_owned(),
        message: format!("{code}: {text}, {operation} '{}'", path),
        code: Some(code.to_owned()),
        cause: None,
        dom: None,
    })
}

fn throw_fs_error2(operation: &str, from: &JsString, to: &JsString, error: std::io::Error) -> ! {
    throw_value(fs_error2(operation, from, to, &error))
}

fn fs_error2(operation: &str, from: &str, to: &str, error: &std::io::Error) -> JsError {
    let code = fs_error_code(error);
    let text = fs_error_text(error);
    JsError {
        identity: Rc::new(()),
        name: "Error".to_owned(),
        message: format!("{code}: {text}, {operation} '{from}' -> '{to}'"),
        code: Some(code.to_owned()),
        cause: None,
        dom: None,
    }
}

fn throw_fs_fd_error(operation: &str, code: &str, description: &str) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "Error".to_owned(),
        message: format!("{code}: {description}, {operation}"),
        code: Some(code.to_owned()),
        cause: None,
        dom: None,
    })
}

fn throw_fs_fd_io_error(operation: &str, error: std::io::Error) -> ! {
    let code = fs_error_code(&error);
    let text = fs_error_text(&error);
    throw_fs_fd_error(operation, code, &text)
}

fn throw_out_of_range(message: String) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "RangeError".to_owned(),
        message,
        code: Some("ERR_OUT_OF_RANGE".to_owned()),
        cause: None,
        dom: None,
    })
}

fn inspected_argument(value: &str) -> String {
    let quote = if !value.contains('\'') {
        '\''
    } else if !value.contains('"') {
        '"'
    } else if !value.contains('`') && !value.contains("${") {
        '`'
    } else {
        '\''
    };
    let mut inspected = String::new();
    inspected.push(quote);
    for character in value.chars() {
        match character {
            '\\' => inspected.push_str("\\\\"),
            '\'' if quote == '\'' => inspected.push_str("\\'"),
            '\u{0008}' => inspected.push_str("\\b"),
            '\t' => inspected.push_str("\\t"),
            '\n' => inspected.push_str("\\n"),
            '\u{000c}' => inspected.push_str("\\f"),
            '\r' => inspected.push_str("\\r"),
            '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}' => {
                use std::fmt::Write;
                let _ = write!(inspected, "\\x{:02X}", character as u32);
            }
            _ => inspected.push(character),
        }
    }
    inspected.push(quote);

    let mut units = 0;
    let mut boundary = inspected.len();
    for (index, character) in inspected.char_indices() {
        let next = units + character.len_utf16();
        if next > 128 {
            boundary = index;
            break;
        }
        units = next;
    }
    if boundary < inspected.len() {
        inspected.truncate(boundary);
        inspected.push_str("...");
    }
    inspected
}

fn throw_invalid_arg_value(prefix: &str, value: &str) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "TypeError".to_owned(),
        message: format!("{prefix}{}", inspected_argument(value)),
        code: Some("ERR_INVALID_ARG_VALUE".to_owned()),
        cause: None,
        dom: None,
    })
}

fn fs_creation_mode(mode: f64) -> u32 {
    fs_creation_mode_named(mode, "mode")
}

fn fs_creation_mode_named(mode: f64, name: &str) -> u32 {
    let received = bytes_received_number(mode);
    if !mode.is_finite() || mode.trunc() != mode {
        throw_out_of_range(format!(
            "The value of \"{name}\" is out of range. It must be an integer. Received {received}"
        ));
    }
    if !(0.0..=4_294_967_295.0).contains(&mode) {
        throw_out_of_range(format!(
            "The value of \"{name}\" is out of range. It must be >= 0 && <= 4294967295. Received {received}"
        ));
    }
    mode as u32
}

pub fn fs_read_file(path: &JsString) -> JsString {
    JsString::from(String::from_utf8_lossy(&fs_read_all(path)).as_ref())
}

fn fs_read_all(path: &JsString) -> Vec<u8> {
    use std::io::Read;
    if path.contains('\0') {
        throw_invalid_arg_value(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ",
            path,
        );
    }
    if !path.is_well_formed() {
        throw_type_error("scriptc: lone UTF-16 read paths are not ported".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // libuv opens directories too, then reports EISDIR from the read.
        options.custom_flags(0x0200_0000); // FILE_FLAG_BACKUP_SEMANTICS
    }
    let mut file = options.open(path.to_utf8_lossy()).unwrap_or_else(|error| {
        #[cfg(windows)]
        let resolved = if path.is_empty() {
            path.clone()
        } else {
            path_win32_resolve(&array_new(vec![path.clone()]))
        };
        #[cfg(windows)]
        let path = &resolved;
        throw_fs_error("open", path, error)
    });
    let metadata = file
        .metadata()
        .unwrap_or_else(|error| throw_fs_fd_io_error("fstat", error));
    if metadata.is_dir() {
        throw_fs_fd_error("read", "EISDIR", "illegal operation on a directory");
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .unwrap_or_else(|error| throw_fs_fd_io_error("read", error));
    bytes
}

pub fn fs_write_file(path: &JsString, data: &JsString) {
    if let Err(error) = std::fs::write(path.to_utf8_lossy(), data.as_bytes()) {
        throw_fs_error("open", path, error);
    }
}

pub fn fs_read_file_bytes(path: &JsString) -> JsBytes<u8> {
    bytes_from_vec(fs_read_all(path))
}

pub fn fs_read_file_bytes_promise(path: &JsString) -> JsPromise<JsBytes<u8>> {
    let path = path.clone();
    promise_from_sync(move || fs_read_file_bytes(&path))
}

/// Snapshot a regular file using Node's default file ReadStream chunk size.
/// The compiler consumes this owning array directly for `for await`; no JS
/// stream engine or background runtime is embedded in the native binary.
pub fn fs_read_stream_chunks(path: &JsString) -> JsArray<JsBytes<u8>> {
    const CHUNK_SIZE: usize = 64 * 1024;
    let bytes = fs_read_all(path);
    array_new(
        bytes
            .chunks(CHUNK_SIZE)
            .map(|chunk| bytes_from_vec(chunk.to_vec()))
            .collect(),
    )
}

pub fn fs_write_file_bytes(path: &JsString, data: &JsBytes<u8>) {
    let result = data.with(|data| {
        let storage = data.storage.borrow();
        std::fs::write(
            path.to_utf8_lossy(),
            &storage[data.offset..data.offset + data.length],
        )
    });
    if let Err(error) = result {
        throw_fs_error("open", path, error);
    }
}

pub fn fs_write_file_promise(
    path: &JsString,
    data: &JsString,
    mode: f64,
    exclusive: bool,
    flush: bool,
) -> JsPromise<()> {
    let path = path.clone();
    let data = data.clone();
    promise_from_sync(move || {
        if flush {
            fs_write_file_flushed(&path, &data, mode, exclusive);
        } else if exclusive {
            fs_write_file_exclusive_mode(&path, &data, mode);
        } else if mode >= 0.0 {
            fs_write_file_mode(&path, &data, mode);
        } else {
            fs_write_file(&path, &data);
        }
    })
}

fn fs_write_file_flushed(path: &JsString, data: &JsString, mode: f64, exclusive: bool) {
    use std::io::Write;
    let creation_mode = if mode >= 0.0 {
        fs_creation_mode(mode)
    } else {
        0o666
    };
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    fs_set_creation_mode(&mut options, creation_mode);
    let mut file = options
        .open(path.to_utf8_lossy())
        .unwrap_or_else(|error| throw_fs_error("open", path, error));
    file.write_all(data.as_bytes())
        .unwrap_or_else(|error| throw_fs_error("write", path, error));
    file.sync_all()
        .unwrap_or_else(|error| throw_fs_error("fsync", path, error));
}

pub fn fs_append_file(path: &JsString, data: &JsString) {
    fs_append_file_mode(path, data, 0o666 as f64, false);
}

pub fn fs_exists(path: &JsString) -> bool {
    std::fs::exists(path.to_utf8_lossy()).unwrap_or(false)
}

fn fs_mkdir_path(path: &JsString) {
    if path.contains('\0') {
        throw_invalid_arg_value(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ",
            path,
        );
    }
    if !path.is_well_formed() {
        throw_type_error("scriptc: lone UTF-16 directory paths are not ported".into());
    }
    // create_dir_all("") succeeds in std; Node still reports an absent path.
    if path.is_empty() {
        throw_fs_error(
            "mkdir",
            path,
            std::io::Error::from(std::io::ErrorKind::NotFound),
        );
    }
}

fn throw_mkdir_error(path: &JsString, error: std::io::Error) -> ! {
    // Node's Windows mkdir binding reports the resolved path; POSIX reports
    // the source spelling. Validation errors above still use the original path.
    #[cfg(windows)]
    let resolved = path_win32_resolve(&array_new(vec![path.clone()]));
    #[cfg(windows)]
    let path = &resolved;
    throw_fs_error("mkdir", path, error)
}

pub fn fs_mkdir(path: &JsString) {
    fs_mkdir_path(path);
    if let Err(error) = std::fs::create_dir(path.to_utf8_lossy()) {
        throw_mkdir_error(path, error);
    }
}

pub fn fs_rm(path: &JsString) {
    if let Err(error) = std::fs::remove_file(path.to_utf8_lossy()) {
        throw_fs_error("rm", path, error);
    }
}

pub fn fs_rmdir(path: &JsString) {
    if let Err(error) = std::fs::remove_dir(path.to_utf8_lossy()) {
        throw_fs_error("rmdir", path, error);
    }
}

pub fn fs_readdir(path: &JsString) -> JsArray<JsString> {
    let entries = match std::fs::read_dir(path.to_utf8_lossy()) {
        Ok(entries) => entries,
        Err(error) => throw_fs_error("scandir", path, error),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => throw_fs_error("scandir", path, error),
        };
        names.push(JsString::from(entry.file_name().to_string_lossy().as_ref()));
    }
    array_new(names)
}

pub fn fs_readdir_promise(path: &JsString) -> JsPromise<JsArray<JsString>> {
    let path = path.clone();
    promise_from_sync(move || fs_readdir(&path))
}

pub fn fs_truncate(path: &JsString, length: f64) {
    let received = bytes_received_number(length);
    if !length.is_finite() || length.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"len\" is out of range. It must be an integer. Received {received}"
        ));
    }
    if !(-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&length) {
        throw_out_of_range(format!(
            "The value of \"len\" is out of range. It must be >= -9007199254740991 && <= 9007199254740991. Received {received}"
        ));
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(path.to_utf8_lossy())
        .unwrap_or_else(|error| throw_fs_error("open", path, error));
    file.set_len(if length > 0.0 { length as u64 } else { 0 })
        .unwrap_or_else(|error| throw_fs_error("truncate", path, error));
}

pub fn fs_truncate_promise(path: &JsString, length: f64) -> JsPromise<()> {
    let path = path.clone();
    promise_from_sync(move || fs_truncate(&path, length))
}

fn glob_segment_matches(pattern: &[char], value: &[char]) -> bool {
    let (mut pattern_index, mut value_index) = (0, 0);
    let (mut star, mut star_value) = (None, 0);
    while value_index < value.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == '?' || pattern[pattern_index] == value[value_index])
        {
            pattern_index += 1;
            value_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == '*' {
            star = Some(pattern_index);
            pattern_index += 1;
            star_value = value_index;
        } else if let Some(star_index) = star {
            pattern_index = star_index + 1;
            star_value += 1;
            value_index = star_value;
        } else {
            return false;
        }
    }
    while pattern_index < pattern.len() && pattern[pattern_index] == '*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn glob_path_matches(pattern: &str, value: &str) -> bool {
    fn matches(pattern: &[&str], value: &[&str]) -> bool {
        match pattern.split_first() {
            None => value.is_empty(),
            Some((&"**", rest)) => {
                matches(rest, value) || (!value.is_empty() && matches(pattern, &value[1..]))
            }
            Some((segment, rest)) => {
                !value.is_empty()
                    && glob_segment_matches(
                        &segment.chars().collect::<Vec<_>>(),
                        &value[0].chars().collect::<Vec<_>>(),
                    )
                    && matches(rest, &value[1..])
            }
        }
    }
    let pattern = pattern
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>();
    let value = value
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>();
    matches(&pattern, &value)
}

fn glob_normalized(value: &std::path::Path) -> String {
    value
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy()),
            std::path::Component::ParentDir => Some("..".into()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub fn fs_glob_sync(
    pattern: &JsString,
    cwd: &JsString,
    excludes: &JsArray<JsString>,
) -> JsArray<JsString> {
    let exclude_values = array_values(excludes);
    for value in std::iter::once(pattern)
        .chain(std::iter::once(cwd))
        .chain(exclude_values.iter())
    {
        if value.contains('\0') {
            throw_invalid_arg_value(
                "The argument must be a string without null bytes. Received ",
                value,
            );
        }
        if !value.is_well_formed() {
            throw_type_error("scriptc: lone UTF-16 glob strings are not ported".into());
        }
    }
    let pattern = pattern.to_utf8_lossy().replace('\\', "/");
    if std::path::Path::new(pattern.as_str()).is_absolute() {
        throw_type_error("scriptc: absolute fs.globSync patterns are not ported".into());
    }
    let excludes = exclude_values
        .into_iter()
        .map(|value| value.to_utf8_lossy().replace('\\', "/"))
        .collect::<Vec<_>>();
    let root = std::path::PathBuf::from(cwd.to_utf8_lossy().to_string());
    let mut pending = vec![(root.clone(), std::path::PathBuf::new())];
    let mut found = Vec::new();
    while let Some((directory, relative)) = pending.pop() {
        let entries = std::fs::read_dir(&directory)
            .unwrap_or_else(|error| throw_fs_error("scandir", cwd, error));
        for entry in entries {
            let entry = entry.unwrap_or_else(|error| throw_fs_error("scandir", cwd, error));
            let child_relative = relative.join(entry.file_name());
            let normalized = glob_normalized(&child_relative);
            let excluded = excludes
                .iter()
                .any(|exclude| glob_path_matches(exclude, &normalized));
            if excluded {
                continue;
            }
            let file_type = entry
                .file_type()
                .unwrap_or_else(|error| throw_fs_error("lstat", cwd, error));
            if file_type.is_dir() {
                pending.push((entry.path(), child_relative));
            } else if glob_path_matches(&pattern, &normalized) {
                found.push(normalized);
            }
        }
    }
    found.sort();
    array_new(found.into_iter().map(JsString::from).collect())
}

pub fn fs_realpath(path: &JsString) -> JsString {
    match std::fs::canonicalize(path.to_utf8_lossy()) {
        Ok(resolved) => fs_realpath_result(&resolved),
        Err(error) => throw_fs_error("realpath", path, error),
    }
}

pub fn fs_mkdtemp(prefix: &JsString) -> JsString {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    for _ in 0..1024 {
        let tick = NEXT.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos() as u64);
        let suffix = format!(
            "{:06x}",
            (nanos ^ tick ^ u64::from(std::process::id())) & 0xff_ffff
        );
        let candidate: JsString = JsString::from(format!("{prefix}{suffix}"));
        match std::fs::create_dir(candidate.to_utf8_lossy()) {
            Ok(()) => return candidate,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => throw_fs_error("mkdtemp", &candidate, error),
        }
    }
    throw_fs_error(
        "mkdtemp",
        prefix,
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "temporary name collision",
        ),
    )
}

pub fn fs_lchmod(path: &JsString, mode: f64) {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(mode as u32);
        if let Err(error) = std::fs::set_permissions(path.to_utf8_lossy(), permissions) {
            throw_fs_error("lchmod", path, error);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, mode);
        unreachable!("scriptc: lchmod reached on a platform where Node does not expose it");
    }
}

pub fn fs_mkdir_recursive(path: &JsString) {
    fs_mkdir_path(path);
    if let Err(error) = std::fs::create_dir_all(path.to_utf8_lossy()) {
        throw_mkdir_error(path, error);
    }
}

pub fn fs_mkdir_promise(
    path: &JsString,
    mode: f64,
    recursive: bool,
) -> JsPromise<Option<JsString>> {
    let path = path.clone();
    promise_from_sync(move || {
        let first_created = if recursive {
            std::path::Path::new(path.to_utf8_lossy())
                .ancestors()
                .take_while(|candidate| !candidate.as_os_str().is_empty())
                .filter(|candidate| {
                    matches!(
                        std::fs::symlink_metadata(candidate),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound
                    )
                })
                .last()
                .map(|candidate| {
                    #[cfg(windows)]
                    {
                        let absolute = if candidate.is_absolute() {
                            candidate.to_path_buf()
                        } else {
                            std::env::current_dir()
                                .unwrap_or_else(|error| throw_fs_error("mkdir", &path, error))
                                .join(candidate)
                        };
                        let absolute = absolute.to_string_lossy();
                        if absolute.starts_with(r"\\?\") {
                            JsString::from(absolute.as_ref())
                        } else if let Some(unc) = absolute.strip_prefix(r"\\") {
                            JsString::from(format!(r"\\?\UNC\{unc}"))
                        } else {
                            JsString::from(format!(r"\\?\{absolute}"))
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        JsString::from(candidate.to_string_lossy().as_ref())
                    }
                })
        } else {
            None
        };
        if mode < 0.0 {
            if recursive {
                fs_mkdir_recursive(&path);
            } else {
                fs_mkdir(&path);
            }
        } else {
            fs_mkdir_mode(&path, mode, recursive);
        }
        first_created
    })
}

pub fn fs_rm_options(path: &JsString, recursive: bool, force: bool) {
    let metadata = match std::fs::symlink_metadata(path.to_utf8_lossy()) {
        Ok(metadata) => metadata,
        Err(error) if force && error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => throw_fs_error("lstat", path, error),
    };
    let result = if metadata.is_dir() {
        if recursive {
            std::fs::remove_dir_all(path.to_utf8_lossy())
        } else {
            std::fs::remove_dir(path.to_utf8_lossy())
        }
    } else {
        std::fs::remove_file(path.to_utf8_lossy())
    };
    if let Err(error) = result {
        throw_fs_error("rm", path, error);
    }
}

/// Promise-facing `fs.rm` ABI. Removal stays synchronous at the filesystem
/// boundary, while the shared promise adapter preserves rejection and
/// microtask ordering without a JavaScript executor.
pub fn fs_rm_promise(path: &JsString, recursive: bool, force: bool) -> JsPromise<()> {
    let path = path.clone();
    promise_from_sync(move || fs_rm_options(&path, recursive, force))
}

pub fn fs_unlink(path: &JsString) {
    if path.contains('\0') {
        throw_invalid_arg_value(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ",
            path,
        );
    }
    if !path.is_well_formed() {
        throw_type_error("scriptc: lone UTF-16 filesystem paths are not ported".into());
    }
    if let Err(error) = std::fs::remove_file(path.to_utf8_lossy()) {
        #[cfg(windows)]
        let resolved = if path.is_empty() {
            path.clone()
        } else {
            path_win32_resolve(&array_new(vec![path.clone()]))
        };
        #[cfg(windows)]
        let path = &resolved;
        throw_fs_error("unlink", path, error);
    }
}

/// Promise-facing `fs.unlink` ABI. The filesystem contract stays centralized
/// in `fs_unlink`; `promise_from_sync` turns its native throw into a rejected
/// promise and schedules observers through the regular microtask machinery.
pub fn fs_unlink_promise(path: &JsString) -> JsPromise<()> {
    let path = path.clone();
    promise_from_sync(move || fs_unlink(&path))
}

pub fn fs_rename_promise(from: &JsString, to: &JsString) -> JsPromise<()> {
    let from = from.clone();
    let to = to.clone();
    promise_from_sync(move || fs_rename(&from, &to))
}

pub fn fs_copy_file(from: &JsString, to: &JsString) {
    for (name, path) in [("src", from), ("dest", to)] {
        if path.contains('\0') {
            throw_invalid_arg_value(
                &format!(
                    "The argument '{name}' must be a string, Uint8Array, or URL without null bytes. Received "
                ),
                path,
            );
        }
        if !path.is_well_formed() {
            throw_type_error("scriptc: lone UTF-16 filesystem paths are not ported".into());
        }
    }
    if let Err(error) = std::fs::copy(from.to_utf8_lossy(), to.to_utf8_lossy()) {
        throw_fs_error2("copyfile", from, to, error);
    }
}

pub fn fs_copy_file_promise(from: &JsString, to: &JsString) -> JsPromise<()> {
    let from = from.clone();
    let to = to.clone();
    promise_from_sync(move || fs_copy_file(&from, &to))
}

pub fn fs_access_promise(path: &JsString, mode: f64) -> JsPromise<()> {
    let path = path.clone();
    promise_from_sync(move || fs_access(&path, mode))
}

pub fn fs_link(from: &JsString, to: &JsString) {
    for (name, path) in [("existingPath", from), ("newPath", to)] {
        if path.contains('\0') {
            throw_invalid_arg_value(
                &format!(
                    "The argument '{name}' must be a string, Uint8Array, or URL without null bytes. Received "
                ),
                path,
            );
        }
        if !path.is_well_formed() {
            throw_type_error("scriptc: lone UTF-16 filesystem paths are not ported".into());
        }
    }
    if let Err(error) = std::fs::hard_link(from.to_utf8_lossy(), to.to_utf8_lossy()) {
        throw_fs_error2("link", from, to, error);
    }
}

fn fs_cp_sync_with_filter(
    from: &JsString,
    to: &JsString,
    recursive: bool,
    dereference: bool,
    filter: &mut impl FnMut(&JsString, &JsString) -> bool,
) {
    for (name, path) in [("src", from), ("dest", to)] {
        if path.contains('\0') {
            throw_invalid_arg_value(
                &format!(
                    "The argument '{name}' must be a string, Uint8Array, or URL without null bytes. Received "
                ),
                path,
            );
        }
        if !path.is_well_formed() {
            throw_type_error("scriptc: lone UTF-16 filesystem paths are not ported".into());
        }
    }

    fn copy_entry(
        from: &std::path::Path,
        to: &std::path::Path,
        recursive: bool,
        dereference: bool,
        filter: &mut impl FnMut(&JsString, &JsString) -> bool,
    ) -> std::io::Result<()> {
        let source = JsString::from(from.to_string_lossy().as_ref());
        let destination = JsString::from(to.to_string_lossy().as_ref());
        if !filter(&source, &destination) {
            return Ok(());
        }
        let metadata = if dereference {
            std::fs::metadata(from)?
        } else {
            std::fs::symlink_metadata(from)?
        };
        if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(from)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, to)?;
            #[cfg(windows)]
            {
                let resolved = from
                    .parent()
                    .unwrap_or_else(|| std::path::Path::new("."))
                    .join(&target);
                if std::fs::metadata(resolved).is_ok_and(|value| value.is_dir()) {
                    std::os::windows::fs::symlink_dir(target, to)?;
                } else {
                    std::os::windows::fs::symlink_file(target, to)?;
                }
            }
            return Ok(());
        }
        if metadata.is_dir() {
            if !recursive {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "recursive option is required to copy a directory",
                ));
            }
            std::fs::create_dir_all(to)?;
            for entry in std::fs::read_dir(from)? {
                let entry = entry?;
                copy_entry(
                    &entry.path(),
                    &to.join(entry.file_name()),
                    true,
                    dereference,
                    filter,
                )?;
            }
            return Ok(());
        }
        std::fs::copy(from, to).map(|_| ())
    }

    let from_path = std::path::PathBuf::from(from.to_utf8_lossy().to_owned());
    let to_path = std::path::PathBuf::from(to.to_utf8_lossy().to_owned());
    if let Err(error) = copy_entry(&from_path, &to_path, recursive, dereference, filter) {
        throw_fs_error2("cp", from, to, error);
    }
}

pub fn fs_cp_sync(from: &JsString, to: &JsString, recursive: bool, dereference: bool) {
    fs_cp_sync_with_filter(from, to, recursive, dereference, &mut |_, _| true);
}

pub fn fs_cp_sync_filtered(
    from: &JsString,
    to: &JsString,
    recursive: bool,
    dereference: bool,
    mut filter: impl FnMut(&JsString, &JsString) -> bool,
) {
    fs_cp_sync_with_filter(from, to, recursive, dereference, &mut filter);
}

pub fn fs_rename(from: &JsString, to: &JsString) {
    for (name, path) in [("oldPath", from), ("newPath", to)] {
        if path.contains('\0') {
            throw_invalid_arg_value(
                &format!(
                    "The argument '{name}' must be a string, Uint8Array, or URL without null bytes. Received "
                ),
                path,
            );
        }
        if !path.is_well_formed() {
            throw_type_error("scriptc: lone UTF-16 filesystem paths are not ported".into());
        }
    }
    if let Err(error) = std::fs::rename(from.to_utf8_lossy(), to.to_utf8_lossy()) {
        #[cfg(windows)]
        let resolved_from = if from.is_empty() {
            from.clone()
        } else {
            path_win32_resolve(&array_new(vec![from.clone()]))
        };
        #[cfg(windows)]
        let resolved_to = if to.is_empty() {
            to.clone()
        } else {
            path_win32_resolve(&array_new(vec![to.clone()]))
        };
        #[cfg(windows)]
        let (from, to) = (&resolved_from, &resolved_to);
        throw_fs_error2("rename", from, to, error);
    }
}

struct FsRenameWork {
    id: u64,
    owner: std::thread::ThreadId,
    from: String,
    to: String,
}

struct FsRenameCompletion {
    id: u64,
    owner: std::thread::ThreadId,
    result: std::io::Result<()>,
}

struct FsRenameState {
    work: VecDeque<FsRenameWork>,
    done: VecDeque<FsRenameCompletion>,
}

struct FsRenamePool {
    state: Mutex<FsRenameState>,
    work_ready: Condvar,
    done_ready: Condvar,
    worker_count: AtomicUsize,
}

struct FsRenameCallback {
    from: JsString,
    to: JsString,
    callback: Box<dyn FnOnce(Option<JsError>)>,
}

static FS_RENAME_POOL: OnceLock<Arc<FsRenamePool>> = OnceLock::new();
static NEXT_FS_RENAME_ID: AtomicU64 = AtomicU64::new(1);

fn fs_rename_pool() -> &'static Arc<FsRenamePool> {
    FS_RENAME_POOL.get_or_init(|| {
        let pool = Arc::new(FsRenamePool {
            state: Mutex::new(FsRenameState {
                work: VecDeque::new(),
                done: VecDeque::new(),
            }),
            work_ready: Condvar::new(),
            done_ready: Condvar::new(),
            worker_count: AtomicUsize::new(0),
        });
        for index in 0..4 {
            let worker_pool = pool.clone();
            if std::thread::Builder::new()
                .name(format!("scriptc-fs-{index}"))
                .spawn(move || fs_rename_worker(worker_pool))
                .is_ok()
            {
                pool.worker_count.fetch_add(1, Ordering::Relaxed);
            }
        }
        pool
    })
}

fn fs_rename_worker(pool: Arc<FsRenamePool>) {
    loop {
        let work = {
            let state = pool
                .state
                .lock()
                .expect("scriptc: poisoned fs worker queue");
            let mut state = pool
                .work_ready
                .wait_while(state, |state| state.work.is_empty())
                .expect("scriptc: poisoned fs worker queue");
            state
                .work
                .pop_front()
                .expect("scriptc: awakened fs worker without work")
        };
        let result = std::fs::rename(&work.from, &work.to);
        let mut state = pool
            .state
            .lock()
            .expect("scriptc: poisoned fs completion queue");
        state.done.push_back(FsRenameCompletion {
            id: work.id,
            owner: work.owner,
            result,
        });
        pool.done_ready.notify_all();
    }
}

pub fn fs_rename_async(from: &JsString, to: &JsString, callback: Box<dyn FnOnce(Option<JsError>)>) {
    let id = NEXT_FS_RENAME_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .expect("scriptc: exhausted fs.rename request ids");
    let owner = std::thread::current().id();
    FS_RENAME_CALLBACKS.with(|callbacks| {
        let previous = callbacks.borrow_mut().insert(
            id,
            FsRenameCallback {
                from: from.clone(),
                to: to.clone(),
                callback,
            },
        );
        assert!(
            previous.is_none(),
            "scriptc: duplicate fs.rename request id"
        );
    });
    let pool = fs_rename_pool();
    let mut state = pool
        .state
        .lock()
        .expect("scriptc: poisoned fs worker queue");
    if pool.worker_count.load(Ordering::Relaxed) == 0 {
        state.done.push_back(FsRenameCompletion {
            id,
            owner,
            result: Err(std::io::Error::new(
                std::io::ErrorKind::ResourceBusy,
                "could not create fs worker",
            )),
        });
        pool.done_ready.notify_all();
        return;
    }
    state.work.push_back(FsRenameWork {
        id,
        owner,
        from: from.to_string(),
        to: to.to_string(),
    });
    pool.work_ready.notify_one();
}

fn fs_renames_pending() -> bool {
    FS_RENAME_CALLBACKS.with(|callbacks| !callbacks.borrow().is_empty())
}

fn fs_rename_completion_index(
    state: &FsRenameState,
    owner: std::thread::ThreadId,
) -> Option<usize> {
    state
        .done
        .iter()
        .position(|completion| completion.owner == owner)
}

fn fs_renames_dispatch_one() -> bool {
    if !fs_renames_pending() {
        return false;
    }
    let owner = std::thread::current().id();
    let completion = {
        let pool = fs_rename_pool();
        let mut state = pool
            .state
            .lock()
            .expect("scriptc: poisoned fs completion queue");
        let Some(index) = fs_rename_completion_index(&state, owner) else {
            return false;
        };
        state
            .done
            .remove(index)
            .expect("scriptc: missing fs.rename completion")
    };
    let pending =
        FS_RENAME_CALLBACKS.with(|callbacks| callbacks.borrow_mut().remove(&completion.id));
    let Some(pending) = pending else {
        return false;
    };
    let error = completion
        .result
        .err()
        .map(|error| fs_error2("rename", &pending.from, &pending.to, &error));
    (pending.callback)(error);
    true
}

fn fs_renames_wait(timeout: Option<std::time::Duration>) {
    let owner = std::thread::current().id();
    let pool = fs_rename_pool();
    let state = pool
        .state
        .lock()
        .expect("scriptc: poisoned fs completion queue");
    if fs_rename_completion_index(&state, owner).is_some() {
        return;
    }
    if let Some(timeout) = timeout {
        let _ = pool
            .done_ready
            .wait_timeout_while(state, timeout, |state| {
                fs_rename_completion_index(state, owner).is_none()
            })
            .expect("scriptc: poisoned fs completion queue");
    } else {
        drop(
            pool.done_ready
                .wait_while(state, |state| {
                    fs_rename_completion_index(state, owner).is_none()
                })
                .expect("scriptc: poisoned fs completion queue"),
        );
    }
}

fn fs_renames_finish() {
    while fs_renames_pending() {
        fs_renames_wait(None);
        let owner = std::thread::current().id();
        let removed = {
            let pool = fs_rename_pool();
            let mut state = pool
                .state
                .lock()
                .expect("scriptc: poisoned fs completion queue");
            fs_rename_completion_index(&state, owner).and_then(|index| state.done.remove(index))
        };
        if let Some(completion) = removed {
            FS_RENAME_CALLBACKS.with(|callbacks| {
                callbacks.borrow_mut().remove(&completion.id);
            });
        }
    }
}

#[cfg(unix)]
pub fn fs_chmod(path: &JsString, mode: f64) {
    use std::os::unix::fs::PermissionsExt;
    let permissions = std::fs::Permissions::from_mode(to_uint32(mode));
    if let Err(error) = std::fs::set_permissions(path.to_utf8_lossy(), permissions) {
        throw_fs_error("chmod", path, error);
    }
}

#[cfg(all(not(unix), not(windows)))]
pub fn fs_chmod(path: &JsString, _mode: f64) {
    if !fs_exists(path) {
        throw_fs_error(
            "chmod",
            path,
            std::io::Error::new(std::io::ErrorKind::NotFound, "path does not exist"),
        );
    }
}

pub fn fs_chmod_promise(path: &JsString, mode: f64) -> JsPromise<()> {
    let path = path.clone();
    promise_from_sync(move || fs_chmod(&path, mode))
}

#[cfg(not(windows))]
pub fn fs_chown(path: &JsString, uid: f64, gid: f64) {
    if let Err(error) = std::fs::metadata(path.to_utf8_lossy()) {
        throw_fs_error("chown", path, error);
    }
    if uid == -1.0 && gid == -1.0 {
        return;
    }
    let owner = format!("{}:{}", uid.trunc() as i64, gid.trunc() as i64);
    let status = std::process::Command::new("chown")
        .arg(owner)
        .arg("--")
        .arg(path.to_utf8_lossy())
        .status();
    if !status.is_ok_and(|status| status.success()) {
        throw_fs_error(
            "chown",
            path,
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "operation not permitted",
            ),
        );
    }
}

#[cfg(unix)]
pub fn fs_write_file_mode(path: &JsString, data: &JsString, mode: f64) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mode = fs_creation_mode(mode);
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path.to_utf8_lossy())
    {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    if let Err(error) = file.write_all(data.as_bytes()) {
        throw_fs_error("write", path, error);
    }
}

#[cfg(unix)]
pub fn fs_write_file_bytes_mode(path: &JsString, data: &JsBytes<u8>, mode: f64) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(fs_creation_mode(mode))
        .open(path.to_utf8_lossy())
        .unwrap_or_else(|error| throw_fs_error("open", path, error));
    let result = data.with(|data| {
        let storage = data.storage.borrow();
        file.write_all(&storage[data.offset..data.offset + data.length])
    });
    if let Err(error) = result {
        throw_fs_error("write", path, error);
    }
}

pub fn fs_write_file_exclusive_mode(path: &JsString, data: &JsString, mode: f64) {
    use std::io::Write;
    let mode = fs_creation_mode(mode);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    fs_set_creation_mode(&mut options, mode);
    let mut file = match options.open(path.to_utf8_lossy()) {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    if let Err(error) = file.write_all(data.as_bytes()) {
        throw_fs_error("write", path, error);
    }
}

pub fn fs_write_file_bytes_exclusive_mode(path: &JsString, data: &JsBytes<u8>, mode: f64) {
    use std::io::Write;
    let mode = fs_creation_mode(mode);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    fs_set_creation_mode(&mut options, mode);
    let mut file = match options.open(path.to_utf8_lossy()) {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    let result = data.with(|data| {
        let storage = data.storage.borrow();
        file.write_all(&storage[data.offset..data.offset + data.length])
    });
    if let Err(error) = result {
        throw_fs_error("write", path, error);
    }
}

#[cfg(unix)]
pub fn fs_mkdir_mode(path: &JsString, mode: f64, recursive: bool) {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = std::fs::DirBuilder::new();
    let mode = fs_creation_mode_named(mode, "options.mode");
    fs_mkdir_path(path);
    builder.recursive(recursive).mode(mode);
    if let Err(error) = builder.create(path.to_utf8_lossy()) {
        throw_mkdir_error(path, error);
    }
}

#[cfg(not(unix))]
pub fn fs_mkdir_mode(path: &JsString, mode: f64, recursive: bool) {
    let _ = fs_creation_mode_named(mode, "options.mode");
    fs_mkdir_path(path);
    if recursive {
        fs_mkdir_recursive(path);
    } else {
        fs_mkdir(path);
    }
}

pub fn fs_mkdir_mode_sync(path: &JsString, mode: f64) {
    fs_mkdir_mode(path, mode, false);
}
pub fn fs_mkdir_recursive_mode_sync(path: &JsString, mode: f64) {
    fs_mkdir_mode(path, mode, true);
}

#[cfg(test)]
mod directory_tests {
    use super::*;

    #[test]
    fn directory_modes_validate_before_paths_or_publication() {
        for recursive in [false, true] {
            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                fs_mkdir_mode(&string("a\0b"), -1.0, recursive);
            }))
            .expect_err("mode validation must throw before path validation");
            let caught = caught_from_panic(payload);
            assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
            assert_eq!(
                caught_error_code(&caught).as_deref(),
                Some("ERR_OUT_OF_RANGE")
            );
            assert!(caught_error_message(&caught).contains("\"options.mode\""));
        }
        for recursive in [false, true] {
            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                fs_mkdir_mode(&empty_string(), 0o700 as f64, recursive);
            }))
            .expect_err("an empty mkdir path must not succeed");
            let caught = caught_from_panic(payload);
            assert_eq!(caught_error_code(&caught).as_deref(), Some("ENOENT"));
        }
    }

    #[test]
    fn directory_mode_wrappers_create_private_recursive_directories() {
        let base = std::env::temp_dir().join(format!("scriptc-mkdir-{}", crypto_random_uuid()));
        let nested = base.join("a").join("b");
        fs_mkdir_recursive_mode_sync(&JsString::from(nested.to_str().unwrap()), 0o700 as f64);
        fs_mkdir_recursive_mode_sync(&JsString::from(nested.to_str().unwrap()), 0o700 as f64);
        assert!(nested.is_dir());
        let single = base.join("single");
        fs_mkdir_mode_sync(&JsString::from(single.to_str().unwrap()), 0o700 as f64);
        assert!(single.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&base, &base.join("a"), &nested, &single] {
                assert_eq!(
                    std::fs::metadata(path).unwrap().permissions().mode() & 0o077,
                    0
                );
            }
        }
        std::fs::remove_dir_all(base).unwrap();
    }
}

#[cfg(not(windows))]
pub fn fs_access(path: &JsString, mode: f64) {
    if let Err(error) = std::fs::metadata(path.to_utf8_lossy()) {
        throw_fs_error("access", path, error);
    }
    let mode = to_int32(mode);
    for (bit, flag) in [(4, "-r"), (2, "-w"), (1, "-x")] {
        if mode & bit == 0 {
            continue;
        }
        let status = std::process::Command::new("test")
            .arg(flag)
            .arg(path.to_utf8_lossy())
            .status();
        if !status.is_ok_and(|status| status.success()) {
            throw_fs_error(
                "access",
                path,
                std::io::Error::new(std::io::ErrorKind::PermissionDenied, "permission denied"),
            );
        }
    }
}

fn fs_open_options(flags: &str) -> std::fs::OpenOptions {
    let mut options = std::fs::OpenOptions::new();
    match flags {
        "r" | "rs" | "sr" => {
            options.read(true);
        }
        "r+" | "rs+" | "sr+" => {
            options.read(true).write(true);
        }
        "w" => {
            options.write(true).create(true).truncate(true);
        }
        "wx" | "xw" => {
            options.write(true).create_new(true).truncate(true);
        }
        "w+" => {
            options.read(true).write(true).create(true).truncate(true);
        }
        "wx+" | "xw+" => {
            options
                .read(true)
                .write(true)
                .create_new(true)
                .truncate(true);
        }
        "a" | "as" | "sa" => {
            options.write(true).create(true).append(true);
        }
        "ax" | "xa" => {
            options.write(true).create_new(true).append(true);
        }
        "a+" | "as+" | "sa+" => {
            options.read(true).create(true).append(true);
        }
        "ax+" | "xa+" => {
            options.read(true).create_new(true).append(true);
        }
        _ => throw_invalid_arg_value("The argument 'flags' is invalid. Received ", flags),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o666);
    }
    options
}

#[cfg(unix)]
fn file_id(file: &std::fs::File) -> i32 {
    use std::os::fd::AsRawFd;
    file.as_raw_fd()
}

#[cfg(not(unix))]
fn file_id(_file: &std::fs::File) -> i32 {
    NEXT_FILE_ID.with(|next| {
        let id = next.get();
        next.set(id.checked_add(1).expect("scriptc: exhausted file ids"));
        id
    })
}

pub fn fs_open(path: &JsString, flags: &JsString) -> f64 {
    fs_open_mode(path, flags, 0o666 as f64)
}

pub fn fs_open_mode(path: &JsString, flags: &JsString, mode: f64) -> f64 {
    if path.contains('\0') {
        throw_invalid_arg_value(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ",
            path,
        );
    }
    if !path.is_well_formed() {
        throw_type_error("scriptc: lone UTF-16 open paths are not ported".into());
    }
    let mut options = fs_open_options(flags);
    fs_set_creation_mode(&mut options, fs_creation_mode(mode));
    let file = match options.open(path.to_utf8_lossy()) {
        Ok(file) => file,
        Err(error) => {
            #[cfg(windows)]
            let resolved = if path.is_empty() {
                path.clone()
            } else {
                path_win32_resolve(&array_new(vec![path.clone()]))
            };
            #[cfg(windows)]
            let path = &resolved;
            throw_fs_error("open", path, error)
        }
    };
    let id = file_id(&file);
    OPEN_FILES.with(|files| {
        let previous = files.borrow_mut().insert(id, file);
        assert!(
            previous.is_none(),
            "scriptc: duplicate open file descriptor"
        );
    });
    f64::from(id)
}

pub struct FileHandleData {
    fd: Cell<i32>,
}

impl Trace for FileHandleData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for FileHandleData {
    fn clear_edges(&mut self) {}
}

impl Drop for FileHandleData {
    fn drop(&mut self) {
        let fd = self.fd.replace(-1);
        if fd >= 0 {
            OPEN_FILES.with(|files| {
                files.borrow_mut().remove(&fd);
            });
        }
    }
}

pub type JsFileHandle = Gc<FileHandleData>;

pub fn file_handle_open(path: &JsString, flags: &JsString, mode: f64) -> JsFileHandle {
    if path.contains('\0') {
        throw_invalid_arg_value(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ",
            path,
        );
    }
    let mode = fs_creation_mode(mode);
    let mut options = fs_open_options(flags);
    fs_set_creation_mode(&mut options, mode);
    let file = match options.open(path.to_utf8_lossy()) {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    file_handle_register(file)
}

pub fn file_handle_open_promise(
    path: &JsString,
    flags: &JsString,
    mode: f64,
) -> JsPromise<JsFileHandle> {
    let path = path.clone();
    let flags = flags.clone();
    promise_from_sync(move || file_handle_open(&path, &flags, mode))
}

fn file_handle_register(file: std::fs::File) -> JsFileHandle {
    let fd = file_id(&file);
    OPEN_FILES.with(|files| {
        let previous = files.borrow_mut().insert(fd, file);
        assert!(
            previous.is_none(),
            "scriptc: duplicate FileHandle descriptor"
        );
    });
    Gc::new(FileHandleData { fd: Cell::new(fd) })
}

pub fn file_handle_fd(handle: &JsFileHandle) -> f64 {
    f64::from(handle.with(|handle| handle.fd.get()))
}

fn file_handle_require_open(handle: &JsFileHandle) -> f64 {
    let fd = file_handle_fd(handle);
    if fd >= 0.0 {
        return fd;
    }
    throw_value(JsError {
        identity: Rc::new(()),
        name: "Error".to_owned(),
        message: "file closed".to_owned(),
        code: Some("EBADF".to_owned()),
        cause: None,
        dom: None,
    })
}

pub fn file_handle_close(handle: &JsFileHandle) {
    let fd = handle.with(|handle| handle.fd.replace(-1));
    if fd < 0 {
        return;
    }
    let file = OPEN_FILES.with(|files| files.borrow_mut().remove(&fd));
    if file.is_none() {
        throw_fs_fd_error("close", "EBADF", "bad file descriptor");
    }
}

pub fn file_handle_close_promise(handle: &JsFileHandle) -> JsPromise<()> {
    let handle = handle.clone();
    promise_from_sync(move || file_handle_close(&handle))
}

pub fn file_handle_read(
    handle: &JsFileHandle,
    bytes: &JsBytes<u8>,
    offset: f64,
    mut length: f64,
    position: f64,
    length_default: bool,
) -> f64 {
    let fd = file_handle_require_open(handle);
    let byte_length = bytes.with(|data| data.length);
    if byte_length == 0 {
        let checked = fs_read_sync(fd, bytes, offset, 0.0, position);
        if (!length_default && (0.0..1.0).contains(&length)) || (length_default && offset == 0.0) {
            return checked;
        }
        throw_value(JsError {
            identity: Rc::new(()),
            name: "TypeError".to_owned(),
            message: "The argument 'buffer' is empty and cannot be written. Received <Buffer >"
                .to_owned(),
            code: Some("ERR_INVALID_ARG_VALUE".to_owned()),
            cause: None,
            dom: None,
        });
    }
    if length_default
        && offset.is_finite()
        && offset.fract() == 0.0
        && (0.0..=byte_length as f64).contains(&offset)
    {
        length = byte_length as f64 - offset;
    }
    fs_read_sync(fd, bytes, offset, length, position)
}

pub fn file_handle_read_promise(
    handle: &JsFileHandle,
    bytes: &JsBytes<u8>,
    offset: f64,
    length: f64,
    position: f64,
) -> JsPromise<f64> {
    let handle = handle.clone();
    let bytes = bytes.clone();
    promise_from_sync(move || file_handle_read(&handle, &bytes, offset, length, position, false))
}

pub fn file_handle_write_bytes(
    handle: &JsFileHandle,
    bytes: &JsBytes<u8>,
    offset: f64,
    mut length: f64,
    position: f64,
    length_default: bool,
) -> f64 {
    let fd = file_handle_require_open(handle);
    let byte_length = bytes.with(|data| data.length);
    if byte_length == 0 {
        return 0.0;
    }
    if length_default
        && offset.is_finite()
        && offset.fract() == 0.0
        && (0.0..=byte_length as f64).contains(&offset)
    {
        length = byte_length as f64 - offset;
    }
    fs_write_sync(fd, bytes, offset, length, position)
}

pub fn file_handle_write_str(
    handle: &JsFileHandle,
    data: &JsString,
    position: f64,
    encoding: &JsString,
) -> f64 {
    let fd = file_handle_require_open(handle);
    fs_write_str_sync(fd, data, position, encoding)
}

pub fn file_handle_read_file_bytes(handle: &JsFileHandle, _encoding: &JsString) -> JsBytes<u8> {
    fs_read_fd_bytes(file_handle_require_open(handle))
}

pub fn file_handle_read_file(handle: &JsFileHandle, encoding: &JsString) -> JsString {
    let bytes = file_handle_read_file_bytes(handle, encoding);
    bytes_to_string(&bytes, encoding)
}

pub fn file_handle_write_file(handle: &JsFileHandle, data: &JsString, _encoding: &JsString) {
    let fd = file_handle_require_open(handle);
    use std::io::Write;
    with_open_file(fd, "write", |file| file.write_all(data.as_bytes()));
}

pub fn file_handle_write_file_bytes(
    handle: &JsFileHandle,
    data: &JsBytes<u8>,
    _encoding: &JsString,
) {
    let fd = file_handle_require_open(handle);
    let input =
        data.with(|data| data.storage.borrow()[data.offset..data.offset + data.length].to_vec());
    use std::io::Write;
    with_open_file(fd, "write", |file| file.write_all(&input));
}

fn with_open_file<T>(
    fd: f64,
    operation: &str,
    use_file: impl FnOnce(&mut std::fs::File) -> std::io::Result<T>,
) -> T {
    let id =
        if fd.is_finite() && fd.fract() == 0.0 && fd >= i32::MIN as f64 && fd <= i32::MAX as f64 {
            fd as i32
        } else {
            throw_fs_fd_error(operation, "EBADF", "bad file descriptor")
        };
    OPEN_FILES.with(|files| {
        let mut files = files.borrow_mut();
        let Some(file) = files.get_mut(&id) else {
            throw_fs_fd_error(operation, "EBADF", "bad file descriptor")
        };
        use_file(file).unwrap_or_else(|error| throw_fs_fd_io_error(operation, error))
    })
}

/// Change permissions through the open descriptor, without resolving its path again.
pub fn fs_fchmod(fd: f64, mode: f64) {
    let mode = fs_creation_mode(mode);
    with_open_file(fd, "fchmod", |file| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(mode))
        }
        #[cfg(not(unix))]
        {
            let mut permissions = file.metadata()?.permissions();
            permissions.set_readonly(mode & 0o200 == 0);
            file.set_permissions(permissions)
        }
    });
}

fn with_preserved_position<T>(
    file: &mut std::fs::File,
    position: f64,
    operation: impl FnOnce(&mut std::fs::File) -> std::io::Result<T>,
) -> std::io::Result<T> {
    use std::io::{Seek, SeekFrom};
    if position == -1.0 {
        return operation(file);
    }
    let original = file.stream_position()?;
    file.seek(SeekFrom::Start(position as u64))?;
    let result = operation(file);
    let restore = file.seek(SeekFrom::Start(original));
    match (result, restore) {
        (Ok(value), Ok(_)) => Ok(value),
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
    }
}

pub fn fs_close(fd: f64) {
    validate_write_fd(fd);
    let id = fd as i32;
    let file = OPEN_FILES.with(|files| files.borrow_mut().remove(&id));
    if file.is_none() {
        throw_fs_fd_error("close", "EBADF", "bad file descriptor");
    }
}

/// The nullish descriptor overload must throw before attempting an OS close.
pub fn fs_close_nullish(kind: &JsString) {
    throw_type_error_code(
        format!(
            "The \"fd\" argument must be of type number. Received {}",
            kind.to_utf8_lossy()
        ),
        "ERR_INVALID_ARG_TYPE",
    );
}

fn validate_write_fd(fd: f64) {
    if !fd.is_finite() || fd.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"fd\" is out of range. It must be an integer. Received {}",
            format_number(fd)
        ));
    }
    if !(0.0..=f64::from(i32::MAX)).contains(&fd) {
        throw_out_of_range(format!(
            "The value of \"fd\" is out of range. It must be >= 0 && <= 2147483647. Received {}",
            format_number(fd)
        ));
    }
}

fn validate_write_window(length: usize, offset: f64, count: f64) -> (usize, usize) {
    if !offset.is_finite() || offset.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be an integer. Received {}",
            format_number(offset)
        ));
    }
    if !(0.0..=9_007_199_254_740_991.0).contains(&offset) {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received {}",
            format_number(offset)
        ));
    }
    if offset > length as f64 {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be <= {length}. Received {}",
            format_number(offset)
        ));
    }
    let offset = offset as usize;
    if count < 0.0 {
        throw_out_of_range(format!(
            "The value of \"length\" is out of range. It must be >= 0. Received {}",
            format_number(count)
        ));
    }
    let remaining = length - offset;
    if count > remaining as f64 {
        throw_out_of_range(format!(
            "The value of \"length\" is out of range. It must be <= {remaining}. Received {}",
            format_number(count)
        ));
    }
    if !count.is_finite() || count.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"length\" is out of range. It must be an integer. Received {}",
            format_number(count)
        ));
    }
    (offset, count as usize)
}

pub fn fs_read_sync(fd: f64, bytes: &JsBytes<u8>, offset: f64, length: f64, position: f64) -> f64 {
    if !offset.is_finite() || offset.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be an integer. Received {}",
            bytes_received_number(offset)
        ));
    }
    if !(0.0..=9_007_199_254_740_991.0).contains(&offset) {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received {}",
            bytes_received_number(offset)
        ));
    }
    // Node normalizes length with ToInt32 before checking the window, position
    // or descriptor. A zero result succeeds even for a closed descriptor.
    let length = to_int32(length);
    if length == 0 {
        return 0.0;
    }
    let byte_length = bytes.with(|data| data.length);
    if byte_length == 0 {
        throw_value(JsError {
            identity: Rc::new(()),
            name: "TypeError".to_owned(),
            message: format!(
                "The argument 'buffer' is empty and cannot be written. Received {}",
                if bytes_is_buffer(bytes) {
                    "<Buffer >"
                } else {
                    "Uint8Array(0) []"
                }
            ),
            code: Some("ERR_INVALID_ARG_VALUE".to_owned()),
            cause: None,
            dom: None,
        });
    }
    if length < 0 {
        throw_out_of_range(format!(
            "The value of \"length\" is out of range. It must be >= 0. Received {length}"
        ));
    }
    let remaining = byte_length as f64 - offset;
    if length as f64 > remaining {
        throw_out_of_range(format!(
            "The value of \"length\" is out of range. It must be <= {}. Received {length}",
            format_number(remaining)
        ));
    }
    if !position.is_finite() || position.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"position\" is out of range. It must be an integer. Received {}",
            bytes_received_number(position)
        ));
    }
    if !(-1.0..=9_007_199_254_740_991.0).contains(&position) {
        throw_out_of_range(format!(
            "The value of \"position\" is out of range. It must be >= -1 && <= 9007199254740991. Received {}",
            bytes_received_number(position)
        ));
    }
    validate_write_fd(fd);
    let offset = offset as usize;
    let length = length as usize;
    use std::io::Read;
    bytes.with(|data| {
        let mut storage = data.storage.borrow_mut();
        let output = &mut storage[data.offset + offset..data.offset + offset + length];
        with_open_file(fd, "read", |file| {
            with_preserved_position(file, position, |file| file.read(output))
        }) as f64
    })
}

pub fn fs_read_fd_bytes(fd: f64) -> JsBytes<u8> {
    use std::io::Read;
    let mut output = Vec::new();
    if fd == STDIN_FD {
        let mut stdin = std::io::stdin().lock();
        if let Err(error) = stdin.read_to_end(&mut output) {
            throw_fs_fd_io_error("read", error);
        }
        return bytes_from_vec(output);
    }
    with_open_file(fd, "read", |file| file.read_to_end(&mut output));
    bytes_from_vec(output)
}

pub fn fs_read_fd(fd: f64, _encoding: &JsString) -> JsString {
    let bytes = fs_read_fd_bytes(fd);
    bytes_to_string(&bytes, &string("utf8"))
}

#[cfg(test)]
mod descriptor_tests {
    use super::*;

    #[test]
    fn sync_read_normalizes_length_before_descriptor_validation() {
        let bytes = bytes_alloc::<u8>(2.0);
        for length in [0.0, -0.0, 0.5, f64::NAN, f64::INFINITY, 4_294_967_296.0] {
            assert_eq!(fs_read_sync(-1.0, &bytes, 99.0, length, -99.0), 0.0);
        }
        let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            fs_read_sync(-1.0, &bytes, 0.0, 4_294_967_297.0, -1.0);
        }))
        .unwrap_err();
        let caught = caught_from_panic(failure);
        assert_eq!(
            caught_error_code(&caught).as_deref(),
            Some("ERR_OUT_OF_RANGE")
        );
        assert!(caught_error_message(&caught).contains("\"fd\""));
    }

    #[test]
    fn sync_read_window_validation_precedes_position_and_fd() {
        let bytes = bytes_alloc::<u8>(2.0);
        for (offset, length, expected) in [(3.0, 1.0, "<= -1"), (0.0, -1.0, ">= 0")] {
            let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                fs_read_sync(-1.0, &bytes, offset, length, -99.0);
            }))
            .unwrap_err();
            let caught = caught_from_panic(failure);
            let message = caught_error_message(&caught);
            assert!(message.contains("\"length\""), "{message}");
            assert!(message.contains(expected), "{message}");
        }
    }

    #[test]
    fn sync_close_checks_numeric_contract_before_lookup() {
        for fd in [-1.0, 0.5, f64::NAN, f64::INFINITY, 2_147_483_648.0] {
            let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fs_close(fd)))
                .unwrap_err();
            let caught = caught_from_panic(failure);
            assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
            assert_eq!(
                caught_error_code(&caught).as_deref(),
                Some("ERR_OUT_OF_RANGE")
            );
        }
    }
}
