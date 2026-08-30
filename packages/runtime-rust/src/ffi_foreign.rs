#[derive(Debug)]
pub enum FfiForeignArg {
    Bool(bool),
    U8(u8),
    U32(u32),
    I32(i32),
    F64(f64),
    Data(Vec<u8>),
}

struct FfiForeignCall {
    token: usize,
    args: Vec<FfiForeignArg>,
}

#[derive(Default)]
struct FfiForeignShared {
    active: HashSet<usize>,
    queue: VecDeque<FfiForeignCall>,
    stopping: bool,
}

struct FfiForeignRegistration {
    key: &'static str,
    identity: usize,
    callback: *const std::ffi::c_void,
    context: *mut std::ffi::c_void,
    token: usize,
    released: bool,
    dispatch: Rc<dyn Fn(&[FfiForeignArg])>,
}

thread_local! {
    static FFI_FOREIGN_REGISTRATIONS: RefCell<Vec<FfiForeignRegistration>> = const {
        RefCell::new(Vec::new())
    };
}

static FFI_FOREIGN_NEXT_TOKEN: AtomicUsize = AtomicUsize::new(1);
static FFI_FOREIGN_SHARED: OnceLock<(Mutex<FfiForeignShared>, Condvar)> = OnceLock::new();

fn ffi_foreign_shared() -> &'static (Mutex<FfiForeignShared>, Condvar) {
    FFI_FOREIGN_SHARED.get_or_init(|| (Mutex::new(FfiForeignShared::default()), Condvar::new()))
}

fn ffi_foreign_lock() -> std::sync::MutexGuard<'static, FfiForeignShared> {
    ffi_foreign_shared()
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn ffi_foreign_init() {
    let mut shared = ffi_foreign_lock();
    shared.stopping = false;
    shared.active.clear();
    shared.queue.clear();
    FFI_FOREIGN_REGISTRATIONS.with(|registrations| registrations.borrow_mut().clear());
}

pub fn ffi_foreign_token() -> usize {
    FFI_FOREIGN_NEXT_TOKEN.fetch_add(1, Ordering::Relaxed)
}

pub fn ffi_foreign_context(token: usize) -> *mut std::ffi::c_void {
    token as *mut std::ffi::c_void
}

pub fn ffi_commit_foreign_callback<D: Fn(&[FfiForeignArg]) + 'static>(
    key: &'static str,
    identity: usize,
    callback: *const std::ffi::c_void,
    context: *mut std::ffi::c_void,
    token: usize,
    dispatch: D,
) {
    FFI_FOREIGN_REGISTRATIONS.with(|registrations| {
        registrations.borrow_mut().push(FfiForeignRegistration {
            key,
            identity,
            callback,
            context,
            token,
            released: false,
            dispatch: Rc::new(dispatch),
        });
    });
    let mut shared = ffi_foreign_lock();
    shared.active.insert(token);
}

pub fn ffi_foreign_callback(
    key: &str,
    identity: usize,
) -> Option<(*const std::ffi::c_void, *mut std::ffi::c_void, usize)> {
    FFI_FOREIGN_REGISTRATIONS.with(|registrations| {
        registrations
            .borrow()
            .iter()
            .find(|entry| entry.key == key && entry.identity == identity && !entry.released)
            .map(|entry| (entry.callback, entry.context, entry.token))
    })
}

pub fn ffi_release_foreign_callback(key: &str, identity: usize, token: usize) {
    let pending = {
        let mut shared = ffi_foreign_lock();
        shared.active.remove(&token);
        shared.queue.iter().any(|call| call.token == token)
    };
    FFI_FOREIGN_REGISTRATIONS.with(|registrations| {
        let mut registrations = registrations.borrow_mut();
        if let Some(index) = registrations.iter().position(|entry| {
            entry.key == key && entry.identity == identity && entry.token == token && !entry.released
        }) {
            if pending {
                registrations[index].released = true;
            } else {
                registrations.remove(index);
            }
        }
    });
}

pub fn ffi_foreign_post(token: usize, args: Vec<FfiForeignArg>) {
    let (lock, ready) = ffi_foreign_shared();
    let mut shared = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if shared.stopping || !shared.active.contains(&token) {
        return;
    }
    shared.queue.push_back(FfiForeignCall { token, args });
    ready.notify_one();
}

pub fn ffi_foreign_arg_f64(args: &[FfiForeignArg], index: usize) -> f64 {
    match args.get(index) {
        Some(FfiForeignArg::F64(value)) => *value,
        _ => panic!("scriptc: invalid staged FFI callback argument"),
    }
}

pub fn ffi_foreign_arg_bool(args: &[FfiForeignArg], index: usize) -> bool {
    match args.get(index) {
        Some(FfiForeignArg::Bool(value)) => *value,
        _ => panic!("scriptc: invalid staged FFI callback argument"),
    }
}

pub fn ffi_foreign_arg_u8(args: &[FfiForeignArg], index: usize) -> f64 {
    match args.get(index) {
        Some(FfiForeignArg::U8(value)) => f64::from(*value),
        _ => panic!("scriptc: invalid staged FFI callback argument"),
    }
}

pub fn ffi_foreign_arg_u32(args: &[FfiForeignArg], index: usize) -> f64 {
    match args.get(index) {
        Some(FfiForeignArg::U32(value)) => f64::from(*value),
        _ => panic!("scriptc: invalid staged FFI callback argument"),
    }
}

pub fn ffi_foreign_arg_i32(args: &[FfiForeignArg], index: usize) -> f64 {
    match args.get(index) {
        Some(FfiForeignArg::I32(value)) => f64::from(*value),
        _ => panic!("scriptc: invalid staged FFI callback argument"),
    }
}

pub fn ffi_foreign_arg_string(args: &[FfiForeignArg], index: usize) -> JsString {
    match args.get(index) {
        Some(FfiForeignArg::Data(value)) => ffi_string_copy_in(value),
        _ => panic!("scriptc: invalid staged FFI callback argument"),
    }
}

pub fn ffi_foreign_arg_bytes(args: &[FfiForeignArg], index: usize) -> JsBytes<u8> {
    match args.get(index) {
        Some(FfiForeignArg::Data(value)) => ffi_bytes_copy_in(value),
        _ => panic!("scriptc: invalid staged FFI callback argument"),
    }
}

fn ffi_foreign_pending() -> bool {
    let shared = ffi_foreign_lock();
    !shared.active.is_empty() || !shared.queue.is_empty()
}

fn ffi_foreign_dispatch_one() -> bool {
    let call = ffi_foreign_lock().queue.pop_front();
    let Some(call) = call else { return false };
    let dispatch = FFI_FOREIGN_REGISTRATIONS.with(|registrations| {
        registrations
            .borrow()
            .iter()
            .find(|entry| entry.token == call.token)
            .map(|entry| entry.dispatch.clone())
    });
    if let Some(dispatch) = dispatch {
        dispatch(&call.args);
    }
    let pending = ffi_foreign_lock()
        .queue
        .iter()
        .any(|queued| queued.token == call.token);
    if !pending {
        FFI_FOREIGN_REGISTRATIONS.with(|registrations| {
            registrations
                .borrow_mut()
                .retain(|entry| entry.token != call.token || !entry.released);
        });
    }
    true
}

fn ffi_foreign_wait(timeout: Option<std::time::Duration>) {
    let (lock, ready) = ffi_foreign_shared();
    let shared = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !shared.queue.is_empty() || shared.active.is_empty() || shared.stopping {
        return;
    }
    if let Some(timeout) = timeout {
        match ready.wait_timeout(shared, timeout) {
            Ok((_shared, _result)) => {}
            Err(poisoned) => {
                let (_shared, _result) = poisoned.into_inner();
            }
        }
    } else {
        let _shared = ready
            .wait(shared)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
}

fn ffi_foreign_finish() {
    {
        let (lock, ready) = ffi_foreign_shared();
        let mut shared = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        shared.stopping = true;
        shared.active.clear();
        shared.queue.clear();
        ready.notify_all();
    }
    FFI_FOREIGN_REGISTRATIONS.with(|registrations| registrations.borrow_mut().clear());
}
