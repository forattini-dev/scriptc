const STDIN_FD: f64 = 0.0;

fn fs_error_code(error: &std::io::Error) -> &'static str {
    #[cfg(unix)]
    if error.raw_os_error() == Some(9) {
        return "EBADF";
    }
    #[cfg(windows)]
    if error.raw_os_error() == Some(6) {
        return "EBADF";
    }
    match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        std::io::ErrorKind::InvalidInput => "EINVAL",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
        std::io::ErrorKind::IsADirectory => "EISDIR",
        std::io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        std::io::ErrorKind::BrokenPipe => "EPIPE",
        _ => "EIO",
    }
}

fn fs_error_text(error: &std::io::Error) -> String {
    if fs_error_code(error) == "EBADF" {
        return "bad file descriptor".to_owned();
    }
    let text = match error.kind() {
        std::io::ErrorKind::NotFound => "no such file or directory",
        std::io::ErrorKind::PermissionDenied => "permission denied",
        std::io::ErrorKind::AlreadyExists => "file already exists",
        std::io::ErrorKind::InvalidInput => "invalid argument",
        std::io::ErrorKind::NotADirectory => "not a directory",
        std::io::ErrorKind::IsADirectory => "illegal operation on a directory",
        std::io::ErrorKind::DirectoryNotEmpty => "directory not empty",
        std::io::ErrorKind::BrokenPipe => "broken pipe",
        _ => return error.to_string(),
    };
    text.to_owned()
}

fn throw_fs_error(operation: &str, path: &JsString, error: std::io::Error) -> ! {
    let code = fs_error_code(&error);
    let text = fs_error_text(&error);
    throw_value(JsError {
        identity: Rc::new(()),
        name: "Error".to_owned(),
        message: format!("{code}: {text}, {operation} '{}'", path),
        code: Some(code.to_owned()),
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
        dom: None,
    }
}

fn throw_fs_fd_error(operation: &str, code: &str, description: &str) -> ! {
    throw_value(JsError {
        identity: Rc::new(()),
        name: "Error".to_owned(),
        message: format!("{code}: {description}, {operation}"),
        code: Some(code.to_owned()),
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
        dom: None,
    })
}

fn fs_creation_mode(mode: f64) -> u32 {
    let received = format_number(mode);
    if !mode.is_finite() || mode.trunc() != mode {
        throw_out_of_range(format!(
            "The value of \"mode\" is out of range. It must be an integer. Received {received}"
        ));
    }
    if !(0.0..=4_294_967_295.0).contains(&mode) {
        throw_out_of_range(format!(
            "The value of \"mode\" is out of range. It must be >= 0 && <= 4294967295. Received {received}"
        ));
    }
    mode as u32
}

pub fn fs_read_file(path: &JsString) -> JsString {
    match std::fs::read(path.as_ref()) {
        Ok(bytes) => Rc::from(String::from_utf8_lossy(&bytes).as_ref()),
        Err(error) => throw_fs_error("open", path, error),
    }
}

pub fn fs_write_file(path: &JsString, data: &JsString) {
    if let Err(error) = std::fs::write(path.as_ref(), data.as_bytes()) {
        throw_fs_error("open", path, error);
    }
}

pub fn fs_read_file_bytes(path: &JsString) -> JsBytes<u8> {
    match std::fs::read(path.as_ref()) {
        Ok(bytes) => bytes_from_vec(bytes),
        Err(error) => throw_fs_error("open", path, error),
    }
}

pub fn fs_write_file_bytes(path: &JsString, data: &JsBytes<u8>) {
    let result = data.with(|data| {
        let storage = data.storage.borrow();
        std::fs::write(
            path.as_ref(),
            &storage[data.offset..data.offset + data.length],
        )
    });
    if let Err(error) = result {
        throw_fs_error("open", path, error);
    }
}

pub fn fs_append_file(path: &JsString, data: &JsString) {
    use std::io::Write;
    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path.as_ref())
    {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    if let Err(error) = file.write_all(data.as_bytes()) {
        throw_fs_error("write", path, error);
    }
}

pub fn fs_exists(path: &JsString) -> bool {
    std::fs::exists(path.as_ref()).unwrap_or(false)
}

pub fn fs_mkdir(path: &JsString) {
    if let Err(error) = std::fs::create_dir(path.as_ref()) {
        throw_fs_error("mkdir", path, error);
    }
}

pub fn fs_rm(path: &JsString) {
    if let Err(error) = std::fs::remove_file(path.as_ref()) {
        throw_fs_error("rm", path, error);
    }
}

pub fn fs_rmdir(path: &JsString) {
    if let Err(error) = std::fs::remove_dir(path.as_ref()) {
        throw_fs_error("rmdir", path, error);
    }
}

pub fn fs_readdir(path: &JsString) -> JsArray<JsString> {
    let entries = match std::fs::read_dir(path.as_ref()) {
        Ok(entries) => entries,
        Err(error) => throw_fs_error("scandir", path, error),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => throw_fs_error("scandir", path, error),
        };
        names.push(Rc::from(entry.file_name().to_string_lossy().as_ref()));
    }
    array_new(names)
}

pub fn fs_realpath(path: &JsString) -> JsString {
    match std::fs::canonicalize(path.as_ref()) {
        Ok(resolved) => Rc::from(resolved.to_string_lossy().as_ref()),
        Err(error) => throw_fs_error("lstat", path, error),
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
        let candidate: JsString = Rc::from(format!("{prefix}{suffix}"));
        match std::fs::create_dir(candidate.as_ref()) {
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
        if let Err(error) = std::fs::set_permissions(path.as_ref(), permissions) {
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
    if let Err(error) = std::fs::create_dir_all(path.as_ref()) {
        throw_fs_error("mkdir", path, error);
    }
}

pub fn fs_rm_options(path: &JsString, recursive: bool, force: bool) {
    let metadata = match std::fs::symlink_metadata(path.as_ref()) {
        Ok(metadata) => metadata,
        Err(error) if force && error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => throw_fs_error("lstat", path, error),
    };
    let result = if metadata.is_dir() {
        if recursive {
            std::fs::remove_dir_all(path.as_ref())
        } else {
            std::fs::remove_dir(path.as_ref())
        }
    } else {
        std::fs::remove_file(path.as_ref())
    };
    if let Err(error) = result {
        throw_fs_error("rm", path, error);
    }
}

pub fn fs_unlink(path: &JsString) {
    if let Err(error) = std::fs::remove_file(path.as_ref()) {
        throw_fs_error("unlink", path, error);
    }
}

pub fn fs_copy_file(from: &JsString, to: &JsString) {
    if let Err(error) = std::fs::copy(from.as_ref(), to.as_ref()) {
        throw_fs_error2("copyfile", from, to, error);
    }
}

pub fn fs_rename(from: &JsString, to: &JsString) {
    if let Err(error) = std::fs::rename(from.as_ref(), to.as_ref()) {
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
    if let Err(error) = std::fs::set_permissions(path.as_ref(), permissions) {
        throw_fs_error("chmod", path, error);
    }
}

#[cfg(not(unix))]
pub fn fs_chmod(path: &JsString, _mode: f64) {
    if !fs_exists(path) {
        throw_fs_error(
            "chmod",
            path,
            std::io::Error::new(std::io::ErrorKind::NotFound, "path does not exist"),
        );
    }
}

pub fn fs_chown(path: &JsString, uid: f64, gid: f64) {
    if let Err(error) = std::fs::metadata(path.as_ref()) {
        throw_fs_error("chown", path, error);
    }
    if uid == -1.0 && gid == -1.0 {
        return;
    }
    let owner = format!("{}:{}", uid.trunc() as i64, gid.trunc() as i64);
    let status = std::process::Command::new("chown")
        .arg(owner)
        .arg("--")
        .arg(path.as_ref())
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
        .open(path.as_ref())
    {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
    if let Err(error) = file.write_all(data.as_bytes()) {
        throw_fs_error("write", path, error);
    }
}

#[cfg(not(unix))]
pub fn fs_write_file_mode(path: &JsString, data: &JsString, mode: f64) {
    let _ = fs_creation_mode(mode);
    fs_write_file(path, data);
}

#[cfg(unix)]
pub fn fs_mkdir_mode(path: &JsString, mode: f64, recursive: bool) {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(recursive).mode(to_uint32(mode));
    if let Err(error) = builder.create(path.as_ref()) {
        throw_fs_error("mkdir", path, error);
    }
}

#[cfg(not(unix))]
pub fn fs_mkdir_mode(path: &JsString, _mode: f64, recursive: bool) {
    if recursive {
        fs_mkdir_recursive(path);
    } else {
        fs_mkdir(path);
    }
}

pub fn fs_access(path: &JsString, mode: f64) {
    if let Err(error) = std::fs::metadata(path.as_ref()) {
        throw_fs_error("access", path, error);
    }
    let mode = to_int32(mode);
    for (bit, flag) in [(4, "-r"), (2, "-w"), (1, "-x")] {
        if mode & bit == 0 {
            continue;
        }
        let status = std::process::Command::new("test")
            .arg(flag)
            .arg(path.as_ref())
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
    let options = fs_open_options(flags);
    let file = match options.open(path.as_ref()) {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let file = match options.open(path.as_ref()) {
        Ok(file) => file,
        Err(error) => throw_fs_error("open", path, error),
    };
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
        if (!length_default && length >= 0.0 && length < 1.0) || (length_default && offset == 0.0) {
            return checked;
        }
        throw_value(JsError {
            identity: Rc::new(()),
            name: "TypeError".to_owned(),
            message: "The argument 'buffer' is empty and cannot be written. Received <Buffer >"
                .to_owned(),
            code: Some("ERR_INVALID_ARG_VALUE".to_owned()),
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
    let id =
        if fd.is_finite() && fd.fract() == 0.0 && fd >= i32::MIN as f64 && fd <= i32::MAX as f64 {
            fd as i32
        } else {
            throw_fs_fd_error("close", "EBADF", "bad file descriptor")
        };
    let file = OPEN_FILES.with(|files| files.borrow_mut().remove(&id));
    if file.is_none() {
        throw_fs_fd_error("close", "EBADF", "bad file descriptor");
    }
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

fn normalized_write_position(position: f64) -> f64 {
    if position.is_finite()
        && position.fract() == 0.0
        && (0.0..=9_007_199_254_740_991.0).contains(&position)
    {
        position
    } else {
        -1.0
    }
}

pub fn fs_write_sync(fd: f64, bytes: &JsBytes<u8>, offset: f64, length: f64, position: f64) -> f64 {
    let byte_length = bytes.with(|data| data.length);
    let (offset, length) = validate_write_window(byte_length, offset, length);
    validate_write_fd(fd);
    let input = bytes.with(|data| {
        data.storage.borrow()[data.offset + offset..data.offset + offset + length].to_vec()
    });
    let position = normalized_write_position(position);
    use std::io::Write;
    with_open_file(fd, "write", |file| {
        with_preserved_position(file, position, |file| file.write(&input))
    }) as f64
}

pub fn fs_write_str_sync(fd: f64, text: &JsString, position: f64, _encoding: &JsString) -> f64 {
    validate_write_fd(fd);
    let position = normalized_write_position(position);
    use std::io::Write;
    with_open_file(fd, "write", |file| {
        with_preserved_position(file, position, |file| file.write(text.as_bytes()))
    }) as f64
}

pub fn fs_read_sync(fd: f64, bytes: &JsBytes<u8>, offset: f64, length: f64, position: f64) -> f64 {
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
    if !position.is_finite() || position.fract() != 0.0 {
        throw_out_of_range(format!(
            "The value of \"position\" is out of range. It must be an integer. Received {}",
            format_number(position)
        ));
    }
    if !(-1.0..=9_007_199_254_740_991.0).contains(&position) {
        throw_out_of_range(format!(
            "The value of \"position\" is out of range. It must be >= -1 && <= 9007199254740991. Received {}",
            format_number(position)
        ));
    }
    if (0.0..1.0).contains(&length) {
        return 0.0;
    }
    let byte_length = bytes.with(|data| data.length);
    if offset > byte_length as f64 {
        throw_out_of_range(format!(
            "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received {}",
            format_number(offset)
        ));
    }
    let offset = offset as usize;
    let remaining = byte_length - offset;
    if length < 0.0 || length > remaining as f64 {
        throw_out_of_range(format!(
            "The value of \"length\" is out of range. It must be <= {remaining}. Received {}",
            format_number(length)
        ));
    }
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
