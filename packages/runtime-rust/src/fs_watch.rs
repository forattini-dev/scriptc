#[derive(Clone, PartialEq, Eq)]
struct FsWatchStamp {
    exists: bool,
    length: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    inode: u64,
}

impl FsWatchStamp {
    fn read(path: &std::path::Path) -> Self {
        match std::fs::metadata(path) {
            Ok(metadata) => Self {
                exists: true,
                length: metadata.len(),
                modified: metadata.modified().ok(),
                #[cfg(unix)]
                inode: {
                    use std::os::unix::fs::MetadataExt;
                    metadata.ino()
                },
            },
            Err(_) => Self {
                exists: false,
                length: 0,
                modified: None,
                #[cfg(unix)]
                inode: 0,
            },
        }
    }

    fn event_type(&self, next: &Self) -> Option<&'static str> {
        if self.exists != next.exists {
            return Some("rename");
        }
        #[cfg(unix)]
        if self.exists && self.inode != next.inode {
            return Some("rename");
        }
        (self != next).then_some("change")
    }
}

pub type FsWatchCallback = Rc<dyn Fn(JsString)>;
pub type FsWatchTrace = Rc<dyn Fn(&mut Tracer<'_>)>;

pub struct FsWatcherData {
    path: std::path::PathBuf,
    stamp: FsWatchStamp,
    closed: bool,
    callback: Option<FsWatchCallback>,
    trace: Option<FsWatchTrace>,
}

impl Trace for FsWatcherData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(trace) = &self.trace {
            trace(tracer);
        }
    }
}

impl ClearEdges for FsWatcherData {
    fn clear_edges(&mut self) {
        self.closed = true;
        self.callback = None;
        self.trace = None;
    }
}

pub type JsFsWatcher = Gc<FsWatcherData>;

thread_local! {
    static FS_WATCHERS: RefCell<Vec<JsFsWatcher>> = const { RefCell::new(Vec::new()) };
}

pub fn fs_watch(
    path: &JsString,
    callback: Option<FsWatchCallback>,
    trace: Option<FsWatchTrace>,
) -> JsFsWatcher {
    let metadata = std::fs::metadata(path.as_ref())
        .unwrap_or_else(|error| throw_fs_error("watch", path, error));
    let stamp = FsWatchStamp {
        exists: true,
        length: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        inode: {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        },
    };
    let watcher = Gc::new(FsWatcherData {
        path: std::path::PathBuf::from(path.as_ref()),
        stamp,
        closed: false,
        callback,
        trace,
    });
    FS_WATCHERS.with(|watchers| watchers.borrow_mut().push(watcher.clone()));
    watcher
}

pub fn fs_watcher_close(watcher: &JsFsWatcher) {
    watcher.with_mut(|data| data.clear_edges());
    FS_WATCHERS.with(|watchers| watchers.borrow_mut().retain(|item| !item.ptr_eq(watcher)));
}

fn fs_watchers_dispatch_one() -> bool {
    let watchers = FS_WATCHERS.with(|watchers| watchers.borrow().clone());
    for watcher in watchers {
        let event = watcher.with_mut(|data| {
            if data.closed {
                return None;
            }
            let next = FsWatchStamp::read(&data.path);
            let event = data.stamp.event_type(&next)?;
            data.stamp = next;
            data.callback.clone().map(|callback| (callback, event))
        });
        if let Some((callback, event)) = event {
            callback(string(event));
            return true;
        }
    }
    false
}

fn fs_watchers_pending() -> bool {
    FS_WATCHERS.with(|watchers| watchers.borrow().iter().any(|watcher| !watcher.with(|data| data.closed)))
}

fn fs_watchers_wait(timeout: Option<std::time::Duration>) {
    let poll = std::time::Duration::from_millis(10);
    std::thread::sleep(timeout.map_or(poll, |wait| wait.min(poll)));
}

fn fs_watchers_finish() {
    let watchers = FS_WATCHERS.with(|watchers| std::mem::take(&mut *watchers.borrow_mut()));
    for watcher in watchers {
        watcher.with_mut(|data| data.clear_edges());
    }
}
