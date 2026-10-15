/// The composed Bun.file(path).text() subset. The path check belongs to the
/// constructor; IO errors belong to the Promise returned by text().
pub fn bun_file_path(path: &JsString) -> JsString {
    if path.to_utf8_lossy().contains('\0') {
        throw_type_error_code(
            format!(
                "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received {}",
                json_stringify(path)
            ),
            "ERR_INVALID_ARG_VALUE",
        );
    }
    path.clone()
}

struct BunFileWork {
    id: u64,
    path: String,
    done: std::sync::mpsc::Sender<BunFileCompletion>,
}

struct BunFileCompletion {
    id: u64,
    result: std::io::Result<Vec<u8>>,
}

struct BunFileState {
    next_id: u64,
    sender: std::sync::mpsc::Sender<BunFileCompletion>,
    receiver: std::sync::mpsc::Receiver<BunFileCompletion>,
    ready: VecDeque<BunFileCompletion>,
    pending: HashMap<u64, (JsString, JsPromise<JsString>)>,
}

impl Default for BunFileState {
    fn default() -> Self {
        let (sender, receiver) = std::sync::mpsc::channel();
        Self {
            next_id: 0,
            sender,
            receiver,
            ready: VecDeque::new(),
            pending: HashMap::new(),
        }
    }
}

thread_local! {
    static BUN_FILES: RefCell<BunFileState> = RefCell::new(BunFileState::default());
}

// Only owned paths and bytes cross threads. JS strings, promises and the GC
// stay on their originating event-loop thread. Two workers bound IO concurrency.
fn bun_file_pool() -> Option<&'static std::sync::mpsc::Sender<BunFileWork>> {
    static POOL: OnceLock<Option<std::sync::mpsc::Sender<BunFileWork>>> = OnceLock::new();
    POOL.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::channel::<BunFileWork>();
        let receiver = Arc::new(Mutex::new(receiver));
        let mut workers = 0;
        for index in 0..2 {
            let receiver = receiver.clone();
            if std::thread::Builder::new()
                .name(format!("scriptc-bun-file-{index}"))
                .spawn(move || {
                    loop {
                        let work = receiver
                            .lock()
                            .expect("scriptc: poisoned Bun file queue")
                            .recv();
                        let Ok(work) = work else { break };
                        let result = if std::fs::metadata(&work.path)
                            .is_ok_and(|metadata| metadata.is_dir())
                        {
                            Err(std::io::Error::from(std::io::ErrorKind::IsADirectory))
                        } else {
                            std::fs::read(&work.path)
                        };
                        let _ = work.done.send(BunFileCompletion {
                            id: work.id,
                            result,
                        });
                    }
                })
                .is_ok()
            {
                workers += 1;
            }
        }
        (workers != 0).then_some(sender)
    })
    .as_ref()
}

pub fn bun_file_text(path: &JsString) -> JsPromise<JsString> {
    let promise = promise_new();
    let work = BUN_FILES.with(|state| {
        let mut state = state.borrow_mut();
        state.next_id = state
            .next_id
            .checked_add(1)
            .expect("scriptc: exhausted Bun file request ids");
        let id = state.next_id;
        state.pending.insert(id, (path.clone(), promise.clone()));
        BunFileWork {
            id,
            path: path.to_string(),
            done: state.sender.clone(),
        }
    });
    let id = work.id;
    if bun_file_pool().is_none_or(|pool| pool.send(work).is_err()) {
        BUN_FILES.with(|state| {
            state.borrow_mut().ready.push_back(BunFileCompletion {
                id,
                result: Err(std::io::Error::new(
                    std::io::ErrorKind::ResourceBusy,
                    "could not create Bun file worker",
                )),
            })
        });
    }
    promise
}

fn bun_file_error(path: &JsString, error: std::io::Error) -> JsError {
    let code = fs_error_code(&error);
    let message = if error.kind() == std::io::ErrorKind::IsADirectory {
        "Directories cannot be read like files".to_owned()
    } else {
        let suffix = if path.to_utf8_lossy().is_empty() {
            String::new()
        } else {
            format!(" '{path}'")
        };
        format!("{code}: {}, open{suffix}", fs_error_text(&error))
    };
    error_new_code("Error", JsString::from(message), code)
}

fn bun_file_decode(bytes: &[u8]) -> JsString {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    JsString::from(String::from_utf8_lossy(bytes).as_ref())
}

fn bun_files_pending() -> bool {
    BUN_FILES.with(|state| !state.borrow().pending.is_empty())
}

fn bun_files_dispatch_one() -> bool {
    let completed = BUN_FILES.with(|state| {
        let mut state = state.borrow_mut();
        let completion = state
            .ready
            .pop_front()
            .or_else(|| state.receiver.try_recv().ok())?;
        let pending = state.pending.remove(&completion.id)?;
        Some((pending, completion.result))
    });
    let Some(((path, promise), result)) = completed else {
        return false;
    };
    match result {
        Ok(bytes) => {
            let _ = promise_fulfill(&promise, bun_file_decode(&bytes));
        }
        Err(error) => {
            let _ = promise_reject(&promise, caught_value(bun_file_error(&path, error)));
        }
    }
    true
}

fn bun_files_wait(timeout: std::time::Duration) {
    BUN_FILES.with(|state| {
        let mut state = state.borrow_mut();
        if state.ready.is_empty()
            && let Ok(completion) = state.receiver.recv_timeout(timeout)
        {
            state.ready.push_back(completion);
        }
    });
}

fn bun_files_finish() {
    BUN_FILES.with(|state| {
        let mut state = state.borrow_mut();
        state.pending.clear();
        state.ready.clear();
        while state.receiver.try_recv().is_ok() {}
    });
}
