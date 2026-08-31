// Shared scaffolding for the event-loop integration tests (net, http, tls,
// dgram, child_process). Everything here is test-only: the helpers exist so a
// stuck loop fails loudly instead of hanging CI, and so the noisy trace/closure
// shapes the code generator emits stay out of the test bodies.

/// Caps how long a `run_event_loop()` may block before the test fails.
///
/// Two layers, because one is not enough:
///
/// The timer is registered UNREFERENCED, so it never keeps the loop alive on
/// its own — a healthy test still exits the moment its real work drains. The
/// loop folds every pending timer into its `next_due` wait bound, so a poll
/// that is merely *waiting* sleeps at most until the deadline, then panics
/// with a named failure instead of wedging the runner.
///
/// A poll that is *spinning* never reaches the timer phase at all: the
/// dispatch chain `continue`s ahead of it. So a watchdog thread backs the
/// timer up and aborts the process a couple of seconds later. Aborting is
/// blunt, but a wedged run loses every result anyway, and this way the
/// transcript says which test wedged.
struct LoopDeadline {
    id: f64,
    finished: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for LoopDeadline {
    fn drop(&mut self) {
        timer_clear(self.id);
        self.finished.store(true, Ordering::Relaxed);
    }
}

fn loop_deadline(delay_ms: f64) -> LoopDeadline {
    let id = timer_set_timeout_handle(
        Box::new(|| panic!("event-loop test exceeded deadline")),
        delay_ms,
    );
    timer_set_ref(id, false);
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watched = finished.clone();
    let grace = std::time::Duration::from_millis(delay_ms as u64) + WATCHDOG_GRACE;
    std::thread::spawn(move || {
        let expiry = std::time::Instant::now() + grace;
        while std::time::Instant::now() < expiry {
            if watched.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if watched.load(Ordering::Relaxed) {
            return;
        }
        eprintln!("scriptc: an event-loop test wedged past its deadline; aborting the run");
        std::process::abort();
    });
    LoopDeadline { id, finished }
}

/// How long the watchdog waits past the in-loop deadline before aborting.
const WATCHDOG_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// The wall-clock budget every integration test in this suite runs under.
const DEADLINE_MS: f64 = 10_000.0;

/// A trace closure that reports no outgoing edges.
///
/// Test listeners capture plain `Rc` transcripts rather than `Gc` handles, so
/// there is no heap edge for the cycle collector to follow and the honest
/// tracer is the empty one. `net`, `dgram` and `child_stream` all take the same
/// `Rc<dyn for<'a> Fn(&mut Tracer<'a>)>` shape.
fn no_trace() -> Rc<dyn for<'a> Fn(&mut Tracer<'a>)> {
    Rc::new(|_tracer| {})
}

/// Non-owning self-reference for a listener that acts on the object storing
/// it — a server that closes itself from its own connection handler, a socket
/// that replies from its own data handler.
///
/// `Gc::downgrade` is the runtime's own answer for exactly this shape: the
/// weak capture never closes an ownership cycle, so the listener owes no trace
/// edge and the object frees the moment the test's stack handle goes away.
/// Upgrading always succeeds inside a listener, because dispatch holds the
/// object for the duration of the call.
fn reborrow<T>(weak: &GcWeak<T>) -> Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    weak.upgrade()
        .expect("listener ran while its own object was alive")
}

/// `child_process`'s exit/error listeners take the boxed flavour of the same
/// closure.
fn no_trace_boxed() -> Box<dyn for<'a> Fn(&mut Tracer<'a>)> {
    Box::new(|_tracer| {})
}

/// Ordered record of the events a test observed.
///
/// Deliberately a plain `Rc<RefCell<..>>` and not a `Gc`: the transcript is
/// test bookkeeping, not part of the object graph under test, and keeping it
/// off the traced heap lets each test assert `live_heap_objects() == 0` without
/// having to reason about its own scaffolding.
type Transcript = Rc<RefCell<Vec<String>>>;

fn transcript() -> Transcript {
    Rc::new(RefCell::new(Vec::new()))
}

fn note(transcript: &Transcript, entry: &str) {
    transcript.borrow_mut().push(entry.to_owned());
}

fn entries(transcript: &Transcript) -> Vec<String> {
    transcript.borrow().clone()
}

fn utf8(chunk: &JsBytes<u8>) -> String {
    String::from_utf8_lossy(&bytes_u8_values(chunk)).into_owned()
}
