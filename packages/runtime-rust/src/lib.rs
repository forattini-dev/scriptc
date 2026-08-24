#![forbid(unsafe_code)]

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::{Rc, Weak};
use std::sync::OnceLock;

static PROCESS_START: OnceLock<std::time::Instant> = OnceLock::new();

/// Owned JavaScript string handle for the static Rust heap.
///
/// `Rc` keeps aliasing explicit and thread-confined. Later heap object
/// families use the same owning-handle rule and add tracing for cycles.
pub type JsString = Rc<str>;

trait DynNode {
    fn id(&self) -> usize;
    fn trace(&self, tracer: &mut Tracer<'_>);
    fn clear_edges(&self);
}

type DynNodeRc = Rc<dyn DynNode>;
type DynNodeWeak = Weak<dyn DynNode>;

thread_local! {
    static NEXT_NODE_ID: Cell<usize> = const { Cell::new(1) };
    static LIVE_NODES: Cell<usize> = const { Cell::new(0) };
    static CYCLE_CANDIDATES: RefCell<Vec<DynNodeWeak>> = const { RefCell::new(Vec::new()) };
    static EXCEPTION_SLOT: RefCell<Option<Rc<dyn Any>>> = const { RefCell::new(None) };
    static PROCESS_ARGV: RefCell<Option<JsArray<JsString>>> = const { RefCell::new(None) };
    static OPEN_FILES: RefCell<HashMap<i32, std::fs::File>> = RefCell::new(HashMap::new());
    #[cfg(not(unix))]
    static NEXT_FILE_ID: Cell<i32> = const { Cell::new(3) };
    static TIMER_TASKS: RefCell<Vec<TimerTask>> = const { RefCell::new(Vec::new()) };
    static NEXT_TIMER_ID: Cell<u64> = const { Cell::new(1) };
    static IMMEDIATE_TASKS: RefCell<Vec<ImmediateTask>> = const { RefCell::new(Vec::new()) };
    static NEXT_IMMEDIATE_ID: Cell<u64> = const { Cell::new(1) };
    static MICROTASKS: RefCell<VecDeque<Box<dyn FnOnce()>>> = const { RefCell::new(VecDeque::new()) };
    static NEXT_TICKS: RefCell<VecDeque<Box<dyn FnOnce()>>> = const { RefCell::new(VecDeque::new()) };
    static EVENT_TURN: Cell<u64> = const { Cell::new(0) };
    static EVENT_PHASE: Cell<u8> = const { Cell::new(0) };
    static FIRING_TIMER_ID: Cell<u64> = const { Cell::new(0) };
    static FIRING_TIMER_REFRESHED: Cell<bool> = const { Cell::new(false) };
    static FIRING_TIMER_CLEARED: Cell<bool> = const { Cell::new(false) };
    static FIRING_TIMER_REFERENCED: Cell<bool> = const { Cell::new(true) };
}

/// Visitor used by generated heap payloads to expose owning edges.
///
/// The visitor stores only `Weak` references, so a collection pass never
/// changes the liveness result it is trying to compute.
pub struct Tracer<'a> {
    visit: &'a mut dyn FnMut(DynNodeWeak),
}

pub fn init() {
    let _ = PROCESS_START.get_or_init(std::time::Instant::now);
}

fn process_elapsed() -> std::time::Duration {
    PROCESS_START.get_or_init(std::time::Instant::now).elapsed()
}

pub fn process_uptime() -> f64 {
    process_elapsed().as_secs_f64()
}

pub fn performance_now() -> f64 {
    process_elapsed().as_secs_f64() * 1000.0
}

pub fn date_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("scriptc: system clock precedes the Unix epoch")
        .as_millis() as f64
}

impl Tracer<'_> {
    pub fn edge<T>(&mut self, edge: &Gc<T>)
    where
        T: Trace + ClearEdges + 'static,
    {
        let node: DynNodeRc = edge.rc().clone();
        (self.visit)(Rc::downgrade(&node));
    }
}

/// Enumerates every owning heap edge in a payload.
pub trait Trace {
    fn trace(&self, tracer: &mut Tracer<'_>);
}

/// Removes every owning heap edge from a payload.
///
/// Collection calls this only for a set proven unreachable. Implementations
/// must leave scalar data valid, but may empty containers and `take()` object
/// fields. This explicit operation is what lets safe Rust break `Rc` cycles.
pub trait ClearEdges {
    fn clear_edges(&mut self);
}

struct Node<T> {
    id: usize,
    value: RefCell<T>,
}

impl<T> DynNode for Node<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn id(&self) -> usize {
        self.id
    }

    fn trace(&self, tracer: &mut Tracer<'_>) {
        self.value.borrow().trace(tracer);
    }

    fn clear_edges(&self) {
        self.value.borrow_mut().clear_edges();
    }
}

impl<T> Drop for Node<T> {
    fn drop(&mut self) {
        LIVE_NODES.with(|count| count.set(count.get() - 1));
    }
}

/// Owned, address-stable handle for JavaScript heap objects.
///
/// `Gc<T>` deliberately exposes closure-based borrows instead of Rust
/// references whose lifetime could escape a runtime operation. Cloning a
/// handle preserves JavaScript identity. Dropping a handle records a weak
/// cycle candidate; `collect_cycles` performs safe trial deletion later.
pub struct Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    inner: Option<Rc<Node<T>>>,
}

impl<T> Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    pub fn new(value: T) -> Self {
        let id = NEXT_NODE_ID.with(|next| {
            let id = next.get();
            next.set(id.checked_add(1).expect("scriptc: heap id overflow"));
            id
        });
        LIVE_NODES.with(|count| count.set(count.get() + 1));
        Self {
            inner: Some(Rc::new(Node {
                id,
                value: RefCell::new(value),
            })),
        }
    }

    pub fn with<R>(&self, read: impl FnOnce(&T) -> R) -> R {
        read(&self.rc().value.borrow())
    }

    pub fn with_mut<R>(&self, write: impl FnOnce(&mut T) -> R) -> R {
        write(&mut self.rc().value.borrow_mut())
    }

    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(self.rc(), other.rc())
    }

    pub fn identity(&self) -> usize {
        self.rc().id
    }

    fn rc(&self) -> &Rc<Node<T>> {
        self.inner.as_ref().expect("scriptc: moved heap handle")
    }
}

impl<T> Clone for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn clone(&self) -> Self {
        Self {
            inner: Some(self.rc().clone()),
        }
    }
}

impl<T> Drop for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn drop(&mut self) {
        let Some(node) = self.inner.take() else {
            return;
        };
        let erased: DynNodeRc = node.clone();
        let candidate = Rc::downgrade(&erased);
        drop(erased);
        drop(node);
        if candidate.strong_count() > 0 {
            CYCLE_CANDIDATES.with(|candidates| candidates.borrow_mut().push(candidate));
        }
    }
}

/// Collect cycles reachable from handles whose reference count decreased.
///
/// The pass snapshots the candidate subgraph, subtracts its internal edges
/// from each node's strong count, marks nodes with outside owners as live,
/// then clears edges only in the unmarked remainder. Working references are
/// explicitly discounted, so the collector itself never keeps garbage live.
pub fn collect_cycles() -> usize {
    let candidates = CYCLE_CANDIDATES.with(|buffer| std::mem::take(&mut *buffer.borrow_mut()));
    let mut nodes = Vec::<DynNodeRc>::new();
    let mut positions = HashMap::<usize, usize>::new();
    let mut queue = VecDeque::<DynNodeRc>::new();

    for candidate in candidates {
        if let Some(node) = candidate.upgrade()
            && !positions.contains_key(&node.id())
        {
            positions.insert(node.id(), nodes.len());
            nodes.push(node.clone());
            queue.push_back(node);
        }
    }

    while let Some(node) = queue.pop_front() {
        node.trace(&mut Tracer {
            visit: &mut |child| {
                let Some(child) = child.upgrade() else {
                    return;
                };
                if positions.contains_key(&child.id()) {
                    return;
                }
                positions.insert(child.id(), nodes.len());
                nodes.push(child.clone());
                queue.push_back(child);
            },
        });
    }

    if nodes.is_empty() {
        return 0;
    }

    let mut incoming = vec![0usize; nodes.len()];
    for node in &nodes {
        node.trace(&mut Tracer {
            visit: &mut |child| {
                if let Some(child) = child.upgrade()
                    && let Some(index) = positions.get(&child.id())
                {
                    incoming[*index] += 1;
                }
            },
        });
    }

    let mut live = HashSet::<usize>::new();
    let mut live_queue = VecDeque::<usize>::new();
    for (index, node) in nodes.iter().enumerate() {
        // One strong reference per node belongs to `nodes`; every other
        // reference not represented by an incoming edge is an outside root.
        let outside = Rc::strong_count(node).saturating_sub(1 + incoming[index]);
        if outside > 0 && live.insert(node.id()) {
            live_queue.push_back(index);
        }
    }

    while let Some(index) = live_queue.pop_front() {
        nodes[index].trace(&mut Tracer {
            visit: &mut |child| {
                let Some(child) = child.upgrade() else {
                    return;
                };
                let Some(child_index) = positions.get(&child.id()).copied() else {
                    return;
                };
                if live.insert(child.id()) {
                    live_queue.push_back(child_index);
                }
            },
        });
    }

    let garbage: Vec<_> = nodes
        .iter()
        .filter(|node| !live.contains(&node.id()))
        .cloned()
        .collect();
    let collected = garbage.len();
    for node in &garbage {
        node.clear_edges();
    }
    drop(garbage);
    drop(nodes);
    collected
}

/// Final safe point for generated executables.
///
/// The optional audit is test-only instrumentation: production binaries pay
/// only the final cycle pass, while differential tests can prove that every
/// traced array/record object was released.
pub fn finish() {
    PROCESS_ARGV.with(|slot| *slot.borrow_mut() = None);
    TIMER_TASKS.with(|tasks| tasks.borrow_mut().clear());
    IMMEDIATE_TASKS.with(|tasks| tasks.borrow_mut().clear());
    MICROTASKS.with(|tasks| tasks.borrow_mut().clear());
    NEXT_TICKS.with(|tasks| tasks.borrow_mut().clear());
    collect_cycles();
    if std::env::var_os("SCRIPTC_RUST_HEAP_AUDIT").is_some() {
        let live = live_heap_objects();
        assert_eq!(live, 0, "scriptc: {live} Rust heap object(s) still live");
    }
}

struct TimerTask {
    id: u64,
    turn: u64,
    due: std::time::Instant,
    delay: std::time::Duration,
    repeat: bool,
    referenced: bool,
    callback: Box<dyn FnMut()>,
}

struct ImmediateTask {
    id: u64,
    turn: u64,
    referenced: bool,
    callback: Box<dyn FnOnce()>,
}

fn timer_delay(delay_ms: f64) -> std::time::Duration {
    let delay_ms = if delay_ms.is_finite() && delay_ms > 0.0 {
        delay_ms.trunc().min(f64::from(i32::MAX)) as u64
    } else {
        0
    };
    std::time::Duration::from_millis(delay_ms)
}

fn timer_schedule(callback: Box<dyn FnMut()>, delay_ms: f64, repeat: bool) -> f64 {
    let delay = timer_delay(delay_ms);
    let id = NEXT_TIMER_ID.with(|next| {
        let id = next.get();
        next.set(id.checked_add(1).expect("scriptc: exhausted timer ids"));
        id
    });
    TIMER_TASKS.with(|tasks| {
        let turn = EVENT_TURN.with(|turn| turn.get());
        let phase = EVENT_PHASE.with(|phase| phase.get());
        tasks.borrow_mut().push(TimerTask {
            id,
            turn: if phase == 1 || phase == 2 {
                turn + 1
            } else {
                turn
            },
            due: std::time::Instant::now() + delay,
            delay,
            repeat,
            referenced: true,
            callback,
        });
    });
    id as f64
}

pub fn timer_set_timeout(callback: Box<dyn FnMut()>, delay_ms: f64) {
    let _ = timer_schedule(callback, delay_ms, false);
}

pub fn timer_set_timeout_handle(callback: Box<dyn FnMut()>, delay_ms: f64) -> f64 {
    timer_schedule(callback, delay_ms, false)
}

pub fn timer_set_interval(callback: Box<dyn FnMut()>, delay_ms: f64) -> f64 {
    timer_schedule(callback, delay_ms, true)
}

pub fn timer_clear(id: f64) {
    if !id.is_finite() || id.fract() != 0.0 || id < 1.0 || id > u64::MAX as f64 {
        return;
    }
    let id = id as u64;
    TIMER_TASKS.with(|tasks| tasks.borrow_mut().retain(|task| task.id != id));
    FIRING_TIMER_ID.with(|firing| {
        if firing.get() == id {
            FIRING_TIMER_CLEARED.with(|cleared| cleared.set(true));
        }
    });
}

pub fn timer_set_ref(id: f64, referenced: bool) -> f64 {
    if id.is_finite() && id.fract() == 0.0 && id >= 1.0 && id <= u64::MAX as f64 {
        let id = id as u64;
        TIMER_TASKS.with(|tasks| {
            if let Some(task) = tasks.borrow_mut().iter_mut().find(|task| task.id == id) {
                task.referenced = referenced;
            }
        });
        FIRING_TIMER_ID.with(|firing| {
            if firing.get() == id {
                FIRING_TIMER_REFERENCED.with(|value| value.set(referenced));
            }
        });
    }
    id
}

pub fn timer_has_ref(id: f64) -> bool {
    if !id.is_finite() || id.fract() != 0.0 || id < 1.0 || id > u64::MAX as f64 {
        return false;
    }
    let id = id as u64;
    let pending = TIMER_TASKS.with(|tasks| {
        tasks
            .borrow()
            .iter()
            .find(|task| task.id == id)
            .map(|task| task.referenced)
    });
    pending.unwrap_or_else(|| {
        FIRING_TIMER_ID.with(|firing| firing.get() == id)
            && FIRING_TIMER_REFERENCED.with(|referenced| referenced.get())
    })
}

pub fn timer_refresh(id: f64) -> f64 {
    if !id.is_finite() || id.fract() != 0.0 || id < 1.0 || id > u64::MAX as f64 {
        return id;
    }
    let id_int = id as u64;
    let refreshed = TIMER_TASKS.with(|tasks| {
        let mut tasks = tasks.borrow_mut();
        if let Some(task) = tasks.iter_mut().find(|task| task.id == id_int) {
            task.due = std::time::Instant::now() + task.delay;
            true
        } else {
            false
        }
    });
    if !refreshed {
        FIRING_TIMER_ID.with(|firing| {
            if firing.get() == id_int {
                FIRING_TIMER_REFRESHED.with(|refreshed| refreshed.set(true));
            }
        });
    }
    id
}

pub fn timer_set_immediate(callback: Box<dyn FnOnce()>) -> f64 {
    let id = NEXT_IMMEDIATE_ID.with(|next| {
        let id = next.get();
        next.set(id.checked_add(1).expect("scriptc: exhausted immediate ids"));
        id
    });
    let turn = EVENT_TURN.with(|turn| turn.get());
    let phase = EVENT_PHASE.with(|phase| phase.get());
    IMMEDIATE_TASKS.with(|tasks| {
        tasks.borrow_mut().push(ImmediateTask {
            id,
            turn: if phase == 2 { turn + 1 } else { turn },
            referenced: true,
            callback,
        });
    });
    id as f64
}

pub fn timer_clear_immediate(id: f64) {
    if !id.is_finite() || id.fract() != 0.0 || id < 1.0 || id > u64::MAX as f64 {
        return;
    }
    IMMEDIATE_TASKS.with(|tasks| tasks.borrow_mut().retain(|task| task.id != id as u64));
}

pub fn timer_set_immediate_ref(id: f64, referenced: bool) -> f64 {
    if id.is_finite() && id.fract() == 0.0 && id >= 1.0 && id <= u64::MAX as f64 {
        let id = id as u64;
        IMMEDIATE_TASKS.with(|tasks| {
            if let Some(task) = tasks.borrow_mut().iter_mut().find(|task| task.id == id) {
                task.referenced = referenced;
            }
        });
    }
    id
}

pub fn timer_immediate_has_ref(id: f64) -> bool {
    if !id.is_finite() || id.fract() != 0.0 || id < 1.0 || id > u64::MAX as f64 {
        return false;
    }
    let id = id as u64;
    IMMEDIATE_TASKS.with(|tasks| {
        tasks
            .borrow()
            .iter()
            .find(|task| task.id == id)
            .is_some_and(|task| task.referenced)
    })
}

pub fn timer_queue_microtask(callback: Box<dyn FnOnce()>) {
    MICROTASKS.with(|tasks| tasks.borrow_mut().push_back(callback));
}

pub fn process_next_tick(callback: Box<dyn FnOnce()>) {
    NEXT_TICKS.with(|tasks| tasks.borrow_mut().push_back(callback));
}

pub fn process_active_resources() -> JsArray<JsString> {
    let timer_count = TIMER_TASKS.with(|tasks| tasks.borrow().len())
        + usize::from(
            FIRING_TIMER_ID.with(|id| id.get() != 0)
                && FIRING_TIMER_CLEARED.with(|cleared| !cleared.get()),
        );
    let immediate_count = IMMEDIATE_TASKS.with(|tasks| tasks.borrow().len());
    let mut resources = Vec::with_capacity(timer_count + immediate_count);
    resources.extend((0..timer_count).map(|_| string("Timeout")));
    resources.extend((0..immediate_count).map(|_| string("Immediate")));
    array_new(resources)
}

fn proc_stat_fields() -> Option<Vec<String>> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let command_end = stat.rfind(')')?;
    Some(
        stat.get(command_end + 2..)?
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
    )
}

fn proc_stat_value(index: usize) -> f64 {
    proc_stat_fields()
        .and_then(|fields| fields.get(index)?.parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn proc_status_value(name: &str) -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                let rest = line.strip_prefix(name)?.trim_start_matches(':').trim();
                rest.split_whitespace().next()?.parse::<f64>().ok()
            })
        })
        .unwrap_or(0.0)
}

pub fn process_cpu_user() -> f64 {
    proc_stat_value(11) * 10_000.0
}

pub fn process_cpu_system() -> f64 {
    proc_stat_value(12) * 10_000.0
}

pub fn process_thread_cpu_user() -> f64 {
    process_cpu_user()
}

pub fn process_thread_cpu_system() -> f64 {
    process_cpu_system()
}

pub fn process_cpu_prev_validate(user: f64, system: f64) {
    for (name, value) in [("user", user), ("system", system)] {
        if !value.is_finite() || value < 0.0 {
            throw_value(JsError {
                name: "RangeError".to_owned(),
                message: format!(
                    "The property 'prevValue.{name}' is invalid. Received {}",
                    format_number(value)
                ),
                code: Some("ERR_INVALID_ARG_VALUE".to_owned()),
            });
        }
    }
}

pub fn process_rusage(index: f64) -> f64 {
    match index as i32 {
        0 => process_cpu_user(),
        1 => process_cpu_system(),
        2 => {
            let linux_high_water = proc_status_value("VmHWM");
            if linux_high_water > 0.0 {
                linux_high_water
            } else {
                std::process::Command::new("ps")
                    .args(["-o", "rss=", "-p"])
                    .arg(std::process::id().to_string())
                    .output()
                    .ok()
                    .filter(|output| output.status.success())
                    .and_then(|output| String::from_utf8(output.stdout).ok())
                    .and_then(|rss| rss.trim().parse::<f64>().ok())
                    .unwrap_or(0.0)
            }
        }
        6 => proc_stat_value(7),
        7 => proc_stat_value(9),
        14 => proc_status_value("voluntary_ctxt_switches"),
        15 => proc_status_value("nonvoluntary_ctxt_switches"),
        _ => 0.0,
    }
}

fn read_memory_number(path: &str) -> f64 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|value| value.split_whitespace().next()?.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(0.0)
}

pub fn process_constrained_memory() -> f64 {
    let v2 = read_memory_number("/sys/fs/cgroup/memory.max");
    if v2 > 0.0 {
        v2
    } else {
        read_memory_number("/sys/fs/cgroup/memory/memory.limit_in_bytes")
    }
}

pub fn process_available_memory() -> f64 {
    let host_available = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|info| {
            info.lines().find_map(|line| {
                let rest = line.strip_prefix("MemAvailable:")?.trim();
                rest.split_whitespace().next()?.parse::<f64>().ok()
            })
        })
        .map_or(0.0, |kilobytes| kilobytes * 1024.0);
    let constrained = process_constrained_memory();
    if constrained > 0.0 {
        let used = read_memory_number("/sys/fs/cgroup/memory.current");
        host_available.min((constrained - used).max(0.0))
    } else {
        host_available
    }
}

pub fn run_event_loop() {
    let mut turn = 0_u64;
    loop {
        EVENT_TURN.with(|current| current.set(turn));
        let next_tick = NEXT_TICKS.with(|tasks| tasks.borrow_mut().pop_front());
        if let Some(next_tick) = next_tick {
            EVENT_PHASE.with(|phase| phase.set(4));
            next_tick();
            continue;
        }
        let mut microtask = MICROTASKS.with(|tasks| tasks.borrow_mut().pop_front());
        if microtask.is_some() {
            while let Some(callback) = microtask {
                EVENT_PHASE.with(|phase| phase.set(3));
                callback();
                microtask = MICROTASKS.with(|tasks| tasks.borrow_mut().pop_front());
            }
            continue;
        }

        let has_referenced_work = TIMER_TASKS
            .with(|tasks| tasks.borrow().iter().any(|task| task.referenced))
            || IMMEDIATE_TASKS.with(|tasks| tasks.borrow().iter().any(|task| task.referenced));
        if !has_referenced_work {
            break;
        }

        let now = std::time::Instant::now();
        let timer = TIMER_TASKS.with(|tasks| {
            let mut tasks = tasks.borrow_mut();
            let index = tasks
                .iter()
                .enumerate()
                .filter(|(_, task)| task.turn <= turn)
                .min_by_key(|(_, task)| (task.due, task.id))
                .and_then(|(index, task)| (task.due <= now).then_some(index))?;
            Some(tasks.swap_remove(index))
        });
        if let Some(mut timer) = timer {
            EVENT_PHASE.with(|phase| phase.set(1));
            FIRING_TIMER_ID.with(|id| id.set(timer.id));
            FIRING_TIMER_REFRESHED.with(|refreshed| refreshed.set(false));
            FIRING_TIMER_CLEARED.with(|cleared| cleared.set(false));
            FIRING_TIMER_REFERENCED.with(|referenced| referenced.set(timer.referenced));
            (timer.callback)();
            let refreshed = FIRING_TIMER_REFRESHED.with(|refreshed| refreshed.get());
            let cleared = FIRING_TIMER_CLEARED.with(|cleared| cleared.get());
            timer.referenced = FIRING_TIMER_REFERENCED.with(|referenced| referenced.get());
            FIRING_TIMER_ID.with(|id| id.set(0));
            if !cleared && (timer.repeat || refreshed) {
                timer.turn = turn + 1;
                timer.due = std::time::Instant::now() + timer.delay;
                TIMER_TASKS.with(|tasks| tasks.borrow_mut().push(timer));
            }
            continue;
        }

        let immediate = IMMEDIATE_TASKS.with(|tasks| {
            let mut tasks = tasks.borrow_mut();
            let index = tasks
                .iter()
                .enumerate()
                .filter(|(_, task)| task.turn <= turn)
                .min_by_key(|(_, task)| task.id)
                .map(|(index, _)| index)?;
            Some(tasks.swap_remove(index))
        });
        if let Some(immediate) = immediate {
            EVENT_PHASE.with(|phase| phase.set(2));
            (immediate.callback)();
            continue;
        }

        EVENT_PHASE.with(|phase| phase.set(0));
        let has_future_turn = TIMER_TASKS
            .with(|tasks| tasks.borrow().iter().any(|task| task.turn > turn))
            || IMMEDIATE_TASKS.with(|tasks| tasks.borrow().iter().any(|task| task.turn > turn));
        if has_future_turn {
            turn = turn
                .checked_add(1)
                .expect("scriptc: exhausted event-loop turns");
            continue;
        }
        let next_due = TIMER_TASKS.with(|tasks| {
            tasks
                .borrow()
                .iter()
                .filter(|task| task.turn <= turn)
                .map(|task| task.due)
                .min()
        });
        let Some(next_due) = next_due else { break };
        if let Some(wait) = next_due.checked_duration_since(std::time::Instant::now()) {
            std::thread::sleep(wait);
        }
    }
    EVENT_PHASE.with(|phase| phase.set(0));
    EVENT_TURN.with(|turn| turn.set(0));
}

#[doc(hidden)]
pub fn live_heap_objects() -> usize {
    LIVE_NODES.with(Cell::get)
}

/// A typed value that can live inside a captured JavaScript binding.
///
/// Generated closures store bindings as traced `Gc` cells. Scalar and string
/// values have no outgoing heap edges; owning `Gc` handles expose their edge
/// to the cycle collector. Generated union values implement this trait by
/// delegating to their generated `Trace` implementation.
pub trait HeapValue: Clone + 'static {
    fn trace_value(&self, _tracer: &mut Tracer<'_>) {}
}

impl HeapValue for f64 {}
impl HeapValue for bool {}
impl HeapValue for usize {}
impl HeapValue for () {}
impl HeapValue for JsString {}
impl HeapValue for JsError {}

impl<T> HeapValue for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn trace_value(&self, tracer: &mut Tracer<'_>) {
        tracer.edge(self);
    }
}

type PromiseReaction<T> = Box<dyn FnOnce(Result<T, Caught>)>;

enum PromiseState<T: HeapValue> {
    Pending(Vec<PromiseReaction<T>>),
    Fulfilled(Option<T>),
    Rejected(Option<Caught>),
}

pub struct PromiseData<T: HeapValue> {
    state: PromiseState<T>,
}

impl<T: HeapValue> Trace for PromiseData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let PromiseState::Fulfilled(Some(value)) = &self.state {
            value.trace_value(tracer);
        }
    }
}

impl<T: HeapValue> ClearEdges for PromiseData<T> {
    fn clear_edges(&mut self) {
        self.state = PromiseState::Pending(Vec::new());
    }
}

pub type JsPromise<T> = Gc<PromiseData<T>>;

pub fn promise_new<T: HeapValue>() -> JsPromise<T> {
    Gc::new(PromiseData {
        state: PromiseState::Pending(Vec::new()),
    })
}

pub fn promise_resolved<T: HeapValue>(value: T) -> JsPromise<T> {
    Gc::new(PromiseData {
        state: PromiseState::Fulfilled(Some(value)),
    })
}

fn promise_schedule<T: HeapValue>(reaction: PromiseReaction<T>, outcome: Result<T, Caught>) {
    timer_queue_microtask(Box::new(move || reaction(outcome)));
}

pub fn promise_then<T: HeapValue>(promise: &JsPromise<T>, reaction: PromiseReaction<T>) {
    let mut reaction = Some(reaction);
    let settled = promise.with_mut(|data| match &mut data.state {
        PromiseState::Pending(reactions) => {
            reactions.push(reaction.take().expect("scriptc: missing promise reaction"));
            None
        }
        PromiseState::Fulfilled(value) => Some(Ok(value
            .as_ref()
            .expect("scriptc: cleared fulfilled promise")
            .clone())),
        PromiseState::Rejected(reason) => Some(Err(reason
            .as_ref()
            .expect("scriptc: cleared rejected promise")
            .clone())),
    });
    if let Some(outcome) = settled {
        promise_schedule(
            reaction.expect("scriptc: settled promise consumed its reaction"),
            outcome,
        );
    }
}

pub fn promise_fulfill<T: HeapValue>(promise: &JsPromise<T>, value: T) -> bool {
    let reactions = promise.with_mut(|data| match &mut data.state {
        PromiseState::Pending(reactions) => Some(std::mem::take(reactions)),
        PromiseState::Fulfilled(_) | PromiseState::Rejected(_) => None,
    });
    let Some(reactions) = reactions else {
        return false;
    };
    promise.with_mut(|data| data.state = PromiseState::Fulfilled(Some(value.clone())));
    for reaction in reactions {
        promise_schedule(reaction, Ok(value.clone()));
    }
    true
}

pub fn promise_reject<T: HeapValue>(promise: &JsPromise<T>, reason: Caught) -> bool {
    let reactions = promise.with_mut(|data| match &mut data.state {
        PromiseState::Pending(reactions) => Some(std::mem::take(reactions)),
        PromiseState::Fulfilled(_) | PromiseState::Rejected(_) => None,
    });
    let Some(reactions) = reactions else {
        return false;
    };
    promise.with_mut(|data| data.state = PromiseState::Rejected(Some(reason.clone())));
    for reaction in reactions {
        promise_schedule(reaction, Err(reason.clone()));
    }
    true
}

pub fn promise_unwrap<T: HeapValue>(outcome: Result<T, Caught>) -> T {
    match outcome {
        Ok(value) => value,
        Err(reason) => rethrow_caught(reason),
    }
}

pub fn promise_run_segment<T, F>(promise: &JsPromise<T>, segment: F)
where
    T: HeapValue,
    F: FnOnce(),
{
    if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(segment)) {
        let _ = promise_reject(promise, caught_from_panic(payload));
    }
}

/// Payload of a shared lexical binding captured by one or more closures.
pub struct CellData<T: HeapValue> {
    value: Option<T>,
}

impl<T: HeapValue> Trace for CellData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(value) = &self.value {
            value.trace_value(tracer);
        }
    }
}

impl<T: HeapValue> ClearEdges for CellData<T> {
    fn clear_edges(&mut self) {
        self.value = None;
    }
}

pub type JsCell<T> = Gc<CellData<T>>;

pub fn cell_new<T: HeapValue>(value: T) -> JsCell<T> {
    Gc::new(CellData { value: Some(value) })
}

pub fn cell_empty<T: HeapValue>() -> JsCell<T> {
    Gc::new(CellData { value: None })
}

pub fn cell_get<T: HeapValue>(cell: &JsCell<T>) -> T {
    cell.with(|data| {
        data.value
            .as_ref()
            .expect("scriptc: read of an uninitialized captured binding")
            .clone()
    })
}

pub fn cell_get_tdz<T: HeapValue>(cell: &JsCell<T>, binding_name: &str) -> T {
    cell.with(|data| match &data.value {
        Some(value) => value.clone(),
        None => throw_reference_error(format!(
            "Cannot access '{binding_name}' before initialization"
        )),
    })
}

pub fn cell_set<T: HeapValue>(cell: &JsCell<T>, value: T) {
    cell.with_mut(|data| data.value = Some(value));
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsError {
    name: String,
    message: String,
    code: Option<String>,
}

impl Trace for JsError {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

pub fn error_new(name: &str, message: JsString) -> JsError {
    JsError {
        name: name.to_owned(),
        message: message.to_string(),
        code: None,
    }
}

#[derive(Clone)]
pub struct Caught {
    value: Rc<dyn Any>,
}

pub enum Completion<T> {
    Normal,
    Return(T),
    Throw(Caught),
    Break(usize),
    Continue(usize),
}

struct ScriptThrow;

pub fn throw_value<T: 'static>(value: T) -> ! {
    EXCEPTION_SLOT.with(|slot| {
        let previous = slot.borrow_mut().replace(Rc::new(value));
        assert!(
            previous.is_none(),
            "scriptc: throw with an occupied exception slot"
        );
    });
    std::panic::resume_unwind(Box::new(ScriptThrow))
}

pub fn throw_reference_error(message: String) -> ! {
    throw_value(JsError {
        name: "ReferenceError".to_owned(),
        message,
        code: None,
    })
}

pub fn throw_type_error(message: String) -> ! {
    throw_value(JsError {
        name: "TypeError".to_owned(),
        message,
        code: None,
    })
}

pub fn throw_syntax_error(message: String) -> ! {
    throw_value(JsError {
        name: "SyntaxError".to_owned(),
        message,
        code: None,
    })
}

pub fn throw_range_error(message: String) -> ! {
    throw_value(JsError {
        name: "RangeError".to_owned(),
        message,
        code: None,
    })
}

pub fn caught_from_panic(payload: Box<dyn Any + Send>) -> Caught {
    match payload.downcast::<ScriptThrow>() {
        Ok(_) => EXCEPTION_SLOT.with(|slot| Caught {
            value: slot
                .borrow_mut()
                .take()
                .expect("scriptc: throw marker without an exception value"),
        }),
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

pub fn rethrow_caught(caught: Caught) -> ! {
    EXCEPTION_SLOT.with(|slot| {
        let previous = slot.borrow_mut().replace(caught.value);
        assert!(
            previous.is_none(),
            "scriptc: rethrow with an occupied exception slot"
        );
    });
    std::panic::resume_unwind(Box::new(ScriptThrow))
}

pub fn caught_is_error(caught: &Caught) -> bool {
    caught.value.is::<JsError>()
}

pub fn caught_is_error_class(caught: &Caught, name: &str) -> bool {
    caught
        .value
        .downcast_ref::<JsError>()
        .is_some_and(|error| name == "Error" || error.name == name)
}

pub fn caught_check_error(caught: &Caught, name: &str) -> JsError {
    if !caught_is_error_class(caught, name) {
        throw_type_error(format!("caught value is not a {name}"));
    }
    caught_error_value(caught)
}

pub fn caught_error_value(caught: &Caught) -> JsError {
    caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value")
        .clone()
}

pub fn caught_error_name(caught: &Caught) -> JsString {
    let error = caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value");
    Rc::<str>::from(error.name.as_str())
}

pub fn caught_error_message(caught: &Caught) -> JsString {
    let error = caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value");
    Rc::<str>::from(error.message.as_str())
}

pub fn caught_error_code(caught: &Caught) -> Option<JsString> {
    caught
        .value
        .downcast_ref::<JsError>()
        .expect("scriptc: narrowed non-Error caught value")
        .code
        .as_deref()
        .map(Rc::<str>::from)
}

pub fn error_name(error: &JsError) -> JsString {
    Rc::from(error.name.as_str())
}

pub fn error_message(error: &JsError) -> JsString {
    Rc::from(error.message.as_str())
}

pub fn error_code(error: &JsError) -> Option<JsString> {
    error.code.as_deref().map(Rc::from)
}

/// A value that may be stored in a traced JavaScript array.
pub trait ArrayElement: Clone + 'static {
    fn trace_element(&self, _tracer: &mut Tracer<'_>) {}
}

pub trait JoinElement: ArrayElement {
    fn append_joined(&self, output: &mut String);
}

impl ArrayElement for f64 {}
impl ArrayElement for bool {}
impl ArrayElement for usize {}
impl ArrayElement for JsString {}

impl JoinElement for f64 {
    fn append_joined(&self, output: &mut String) {
        output.push_str(&format_number(*self));
    }
}

impl JoinElement for bool {
    fn append_joined(&self, output: &mut String) {
        output.push_str(if *self { "true" } else { "false" });
    }
}

impl JoinElement for JsString {
    fn append_joined(&self, output: &mut String) {
        output.push_str(self);
    }
}

impl<T> ArrayElement for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn trace_element(&self, tracer: &mut Tracer<'_>) {
        tracer.edge(self);
    }
}

pub struct ArrayData<T: ArrayElement> {
    elements: Vec<T>,
}

impl<T: ArrayElement> Trace for ArrayData<T> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for element in &self.elements {
            element.trace_element(tracer);
        }
    }
}

impl<T: ArrayElement> ClearEdges for ArrayData<T> {
    fn clear_edges(&mut self) {
        self.elements.clear();
    }
}

pub type JsArray<T> = Gc<ArrayData<T>>;

pub fn array_new<T: ArrayElement>(elements: Vec<T>) -> JsArray<T> {
    Gc::new(ArrayData { elements })
}

pub fn array_len<T: ArrayElement>(array: &JsArray<T>) -> f64 {
    array.with(|data| data.elements.len() as f64)
}

pub fn array_get<T: ArrayElement>(array: &JsArray<T>, index: f64) -> T {
    let index = array_index(index, false, array_len(array) as usize);
    array.with(|data| data.elements[index].clone())
}

pub fn array_set<T: ArrayElement>(array: &JsArray<T>, index: f64, value: T) {
    let len = array_len(array) as usize;
    let index = array_index(index, true, len);
    array.with_mut(|data| {
        if index == len {
            data.elements.push(value);
        } else {
            data.elements[index] = value;
        }
    });
}

pub fn array_push<T: ArrayElement>(array: &JsArray<T>, value: T) -> f64 {
    array.with_mut(|data| {
        data.elements.push(value);
        data.elements.len() as f64
    })
}

pub fn array_extend<T: ArrayElement>(array: &JsArray<T>, source: &JsArray<T>) -> f64 {
    let snapshot = source.with(|data| data.elements.clone());
    array.with_mut(|data| {
        data.elements.extend(snapshot);
        data.elements.len() as f64
    })
}

pub fn array_index_of_by<T, F>(array: &JsArray<T>, needle: &T, equal: F) -> f64
where
    T: ArrayElement,
    F: Fn(&T, &T) -> bool,
{
    array.with(|data| {
        data.elements
            .iter()
            .position(|element| equal(element, needle))
            .map_or(-1.0, |index| index as f64)
    })
}

pub fn array_includes_by<T, F>(array: &JsArray<T>, needle: &T, equal: F) -> bool
where
    T: ArrayElement,
    F: Fn(&T, &T) -> bool,
{
    array.with(|data| data.elements.iter().any(|element| equal(element, needle)))
}

pub fn array_join<T: JoinElement>(array: &JsArray<T>, separator: &JsString) -> JsString {
    array.with(|data| {
        let mut output = String::new();
        for (index, element) in data.elements.iter().enumerate() {
            if index > 0 {
                output.push_str(separator);
            }
            element.append_joined(&mut output);
        }
        Rc::<str>::from(output)
    })
}

pub fn array_pop<T: ArrayElement>(array: &JsArray<T>) -> T {
    array
        .with_mut(|data| data.elements.pop())
        .expect("scriptc: array index out of bounds")
}

pub fn array_ptr_eq<T: ArrayElement>(left: &JsArray<T>, right: &JsArray<T>) -> bool {
    left.ptr_eq(right)
}

pub trait ByteElement: Copy + Default + 'static {
    fn from_number(value: f64) -> Self;
    fn to_number(self) -> f64;
}

impl ByteElement for u8 {
    fn from_number(value: f64) -> Self {
        to_uint32(value) as u8
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
}

impl ByteElement for u32 {
    fn from_number(value: f64) -> Self {
        to_uint32(value)
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
}

impl ByteElement for i32 {
    fn from_number(value: f64) -> Self {
        to_int32(value)
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
}

impl ByteElement for f32 {
    fn from_number(value: f64) -> Self {
        value as f32
    }
    fn to_number(self) -> f64 {
        f64::from(self)
    }
}

pub struct BytesData<T: ByteElement> {
    storage: Rc<RefCell<Vec<T>>>,
    offset: usize,
    length: usize,
}

impl<T: ByteElement> Trace for BytesData<T> {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl<T: ByteElement> ClearEdges for BytesData<T> {
    fn clear_edges(&mut self) {
        self.storage = Rc::new(RefCell::new(Vec::new()));
        self.offset = 0;
        self.length = 0;
    }
}

pub type JsBytes<T> = Gc<BytesData<T>>;

pub fn bytes_empty<T: ByteElement>() -> JsBytes<T> {
    Gc::new(BytesData {
        storage: Rc::new(RefCell::new(Vec::new())),
        offset: 0,
        length: 0,
    })
}

pub fn bytes_alloc<T: ByteElement>(length: f64) -> JsBytes<T> {
    let length = if length.is_nan() { 0.0 } else { length.trunc() };
    if length < 0.0 || !length.is_finite() || length > usize::MAX as f64 {
        throw_range_error(format!("Invalid typed array length: {length}"));
    }
    let length = length as usize;
    Gc::new(BytesData {
        storage: Rc::new(RefCell::new(vec![T::default(); length])),
        offset: 0,
        length,
    })
}

pub fn bytes_copy<T: ByteElement>(bytes: &JsBytes<T>) -> JsBytes<T> {
    bytes.with(|data| {
        let copied = data.storage.borrow()[data.offset..data.offset + data.length].to_vec();
        Gc::new(BytesData {
            length: copied.len(),
            storage: Rc::new(RefCell::new(copied)),
            offset: 0,
        })
    })
}

pub fn bytes_from_array<T: ByteElement>(array: &JsArray<f64>) -> JsBytes<T> {
    let elements: Vec<T> =
        array.with(|data| data.elements.iter().copied().map(T::from_number).collect());
    Gc::new(BytesData {
        length: elements.len(),
        storage: Rc::new(RefCell::new(elements)),
        offset: 0,
    })
}

pub fn bytes_len<T: ByteElement>(bytes: &JsBytes<T>) -> f64 {
    bytes.with(|data| data.length as f64)
}

pub fn bytes_byte_len<T: ByteElement>(bytes: &JsBytes<T>) -> f64 {
    bytes.with(|data| (data.length * std::mem::size_of::<T>()) as f64)
}

fn bytes_index<T: ByteElement>(bytes: &JsBytes<T>, index: f64) -> usize {
    assert!(
        index.is_finite() && index >= 0.0 && index.fract() == 0.0,
        "scriptc: bytes index out of bounds"
    );
    let index = index as usize;
    assert!(
        index < bytes.with(|data| data.length),
        "scriptc: bytes index out of bounds"
    );
    index
}

pub fn bytes_get<T: ByteElement>(bytes: &JsBytes<T>, index: f64) -> f64 {
    let index = bytes_index(bytes, index);
    bytes.with(|data| data.storage.borrow()[data.offset + index].to_number())
}

pub fn bytes_set<T: ByteElement>(bytes: &JsBytes<T>, index: f64, value: f64) {
    let index = bytes_index(bytes, index);
    bytes.with(|data| data.storage.borrow_mut()[data.offset + index] = T::from_number(value));
}

pub fn atomics_wait(bytes: &JsBytes<i32>, index: f64, expected: f64, timeout_ms: f64) -> JsString {
    if bytes_get(bytes, index) != f64::from(to_int32(expected)) {
        return string("not-equal");
    }
    if timeout_ms.is_finite() && timeout_ms > 0.0 {
        std::thread::sleep(std::time::Duration::from_secs_f64(timeout_ms / 1000.0));
    }
    string("timed-out")
}

fn bytes_relative_index(index: f64, length: usize, default: usize) -> usize {
    if index.is_nan() {
        return 0;
    }
    if index == f64::INFINITY {
        return length;
    }
    if index == f64::NEG_INFINITY {
        return 0;
    }
    let index = index.trunc();
    if index < 0.0 {
        (length as f64 + index).max(0.0) as usize
    } else if index.is_finite() {
        index.min(length as f64) as usize
    } else {
        default
    }
}

pub fn bytes_slice<T: ByteElement>(
    bytes: &JsBytes<T>,
    start: f64,
    end: f64,
    view: bool,
) -> JsBytes<T> {
    bytes.with(|data| {
        let start = bytes_relative_index(start, data.length, 0);
        let end = bytes_relative_index(end, data.length, data.length).max(start);
        if view {
            Gc::new(BytesData {
                storage: data.storage.clone(),
                offset: data.offset + start,
                length: end - start,
            })
        } else {
            let copied = data.storage.borrow()[data.offset + start..data.offset + end].to_vec();
            Gc::new(BytesData {
                length: copied.len(),
                storage: Rc::new(RefCell::new(copied)),
                offset: 0,
            })
        }
    })
}

pub fn bytes_set_from<T: ByteElement>(target: &JsBytes<T>, source: &JsBytes<T>, offset: f64) {
    let offset = if offset.is_nan() { 0.0 } else { offset.trunc() };
    let target_length = target.with(|data| data.length);
    let source_values =
        source.with(|data| data.storage.borrow()[data.offset..data.offset + data.length].to_vec());
    if offset < 0.0
        || !offset.is_finite()
        || offset > target_length as f64
        || source_values.len() > target_length - offset as usize
    {
        throw_range_error("offset is out of bounds".to_owned());
    }
    target.with(|data| {
        let start = data.offset + offset as usize;
        data.storage.borrow_mut()[start..start + source_values.len()]
            .copy_from_slice(&source_values);
    });
}

fn decode_bytes(values: &[u8], encoding: &str) -> JsString {
    match encoding {
        "hex" => {
            let mut output = String::with_capacity(values.len() * 2);
            for byte in values {
                use std::fmt::Write;
                let _ = write!(output, "{byte:02x}");
            }
            Rc::from(output)
        }
        "base64" => Rc::from(bytes_base64_encode(values)),
        "utf8" | "utf-8" => Rc::from(String::from_utf8_lossy(values).as_ref()),
        other => throw_type_error(format!("Unknown encoding: {other}")),
    }
}

fn bytes_decode_index(index: f64, length: usize) -> usize {
    if index.is_nan() || index <= 0.0 {
        0
    } else if index >= length as f64 {
        length
    } else {
        index.trunc() as usize
    }
}

pub fn bytes_to_string(bytes: &JsBytes<u8>, encoding: &JsString) -> JsString {
    bytes_to_string_range(bytes, encoding, 0.0, f64::INFINITY)
}

pub fn bytes_to_string_range(
    bytes: &JsBytes<u8>,
    encoding: &JsString,
    start: f64,
    end: f64,
) -> JsString {
    bytes.with(|data| {
        let start = bytes_decode_index(start, data.length);
        let end = bytes_decode_index(end, data.length).max(start);
        let storage = data.storage.borrow();
        decode_bytes(
            &storage[data.offset + start..data.offset + end],
            encoding.as_ref(),
        )
    })
}

fn bytes_from_vec(values: Vec<u8>) -> JsBytes<u8> {
    Gc::new(BytesData {
        length: values.len(),
        storage: Rc::new(RefCell::new(values)),
        offset: 0,
    })
}

fn bytes_hex_decode(text: &str) -> Vec<u8> {
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let mut output = Vec::with_capacity(text.len() / 2);
    for pair in text.as_bytes().chunks_exact(2) {
        let (Some(high), Some(low)) = (nibble(pair[0]), nibble(pair[1])) else {
            break;
        };
        output.push((high << 4) | low);
    }
    output
}

fn bytes_base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

fn bytes_base64_decode(text: &str) -> Vec<u8> {
    let values: Vec<u8> = text
        .bytes()
        .take_while(|byte| *byte != b'=')
        .filter_map(bytes_base64_value)
        .collect();
    let mut output = Vec::with_capacity(values.len() * 3 / 4);
    for chunk in values.chunks(4) {
        if chunk.len() < 2 {
            break;
        }
        output.push((chunk[0] << 2) | (chunk[1] >> 4));
        if chunk.len() >= 3 {
            output.push((chunk[1] << 4) | (chunk[2] >> 2));
        }
        if chunk.len() == 4 {
            output.push((chunk[2] << 6) | chunk[3]);
        }
    }
    output
}

fn bytes_base64_encode(values: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(values.len().div_ceil(3) * 4);
    for chunk in values.chunks(3) {
        output.push(char::from(ALPHABET[(chunk[0] >> 2) as usize]));
        output.push(char::from(
            ALPHABET[((chunk[0] & 3) << 4 | chunk.get(1).copied().unwrap_or(0) >> 4) as usize],
        ));
        if let Some(second) = chunk.get(1) {
            output.push(char::from(
                ALPHABET[((second & 15) << 2 | chunk.get(2).copied().unwrap_or(0) >> 6) as usize],
            ));
        } else {
            output.push('=');
        }
        if let Some(third) = chunk.get(2) {
            output.push(char::from(ALPHABET[(third & 63) as usize]));
        } else {
            output.push('=');
        }
    }
    output
}

pub fn buffer_from_string(value: &JsString, encoding: &JsString) -> JsBytes<u8> {
    bytes_from_vec(match encoding.as_ref() {
        "hex" => bytes_hex_decode(value),
        "base64" | "base64url" => bytes_base64_decode(value),
        "utf8" | "utf-8" => value.as_bytes().to_vec(),
        other => throw_type_error(format!("Unknown encoding: {other}")),
    })
}

pub fn buffer_concat(values: &JsArray<JsBytes<u8>>) -> JsBytes<u8> {
    let mut output = Vec::new();
    values.with(|array| {
        for bytes in &array.elements {
            bytes.with(|data| {
                output.extend_from_slice(
                    &data.storage.borrow()[data.offset..data.offset + data.length],
                );
            });
        }
    });
    bytes_from_vec(output)
}

fn bytes_num_width(kind: &str) -> usize {
    match kind {
        "u8" | "i8" => 1,
        "u16be" | "u16le" | "i16be" | "i16le" => 2,
        "u32be" | "u32le" | "i32be" | "i32le" | "f32be" | "f32le" => 4,
        "f64be" | "f64le" => 8,
        _ => panic!("scriptc: invalid bytes numeric kind"),
    }
}

fn bytes_num_offset(bytes: &JsBytes<u8>, offset: f64, width: usize, reading: bool) -> usize {
    let length = bytes.with(|data| data.length);
    if width > length
        || !offset.is_finite()
        || offset.fract() != 0.0
        || offset < 0.0
        || offset > length.saturating_sub(width) as f64
    {
        if reading {
            throw_range_error("Attempt to access memory outside buffer bounds".to_owned());
        }
        throw_range_error(format!(
            "The value of \"offset\" is out of range. It must be >= 0 and <= {}. Received {}",
            length.saturating_sub(width),
            format_number(offset)
        ));
    }
    offset as usize
}

pub fn bytes_read_num(bytes: &JsBytes<u8>, kind: &str, offset: f64) -> f64 {
    let width = bytes_num_width(kind);
    let offset = bytes_num_offset(bytes, offset, width, true);
    bytes.with(|data| {
        let storage = data.storage.borrow();
        let input = &storage[data.offset + offset..data.offset + offset + width];
        match kind {
            "u8" => f64::from(input[0]),
            "i8" => f64::from(input[0] as i8),
            "u16be" => f64::from(u16::from_be_bytes([input[0], input[1]])),
            "u16le" => f64::from(u16::from_le_bytes([input[0], input[1]])),
            "i16be" => f64::from(i16::from_be_bytes([input[0], input[1]])),
            "i16le" => f64::from(i16::from_le_bytes([input[0], input[1]])),
            "u32be" => f64::from(u32::from_be_bytes(input.try_into().expect("four bytes"))),
            "u32le" => f64::from(u32::from_le_bytes(input.try_into().expect("four bytes"))),
            "i32be" => f64::from(i32::from_be_bytes(input.try_into().expect("four bytes"))),
            "i32le" => f64::from(i32::from_le_bytes(input.try_into().expect("four bytes"))),
            "f32be" => f64::from(f32::from_be_bytes(input.try_into().expect("four bytes"))),
            "f32le" => f64::from(f32::from_le_bytes(input.try_into().expect("four bytes"))),
            "f64be" => f64::from_be_bytes(input.try_into().expect("eight bytes")),
            "f64le" => f64::from_le_bytes(input.try_into().expect("eight bytes")),
            _ => unreachable!(),
        }
    })
}

pub fn bytes_write_num(bytes: &JsBytes<u8>, kind: &str, value: f64, offset: f64) -> f64 {
    let width = bytes_num_width(kind);
    let offset = bytes_num_offset(bytes, offset, width, false);
    let bits = match kind {
        "u8" | "u16be" | "u16le" | "u32be" | "u32le" => {
            let max = 2_f64.powi((width * 8) as i32) - 1.0;
            if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > max {
                throw_range_error(format!(
                    "The value of \"value\" is out of range. It must be >= 0 and <= {}. Received {}",
                    format_number(max),
                    format_number(value)
                ));
            }
            (value as u64).to_be_bytes()
        }
        "i8" | "i16be" | "i16le" | "i32be" | "i32le" => {
            let max = 2_f64.powi((width * 8 - 1) as i32) - 1.0;
            let min = -max - 1.0;
            if !value.is_finite() || value.fract() != 0.0 || value < min || value > max {
                throw_range_error(format!(
                    "The value of \"value\" is out of range. Received {}",
                    format_number(value)
                ));
            }
            (value as i64 as u64).to_be_bytes()
        }
        "f32be" | "f32le" => u64::from((value as f32).to_bits()).to_be_bytes(),
        "f64be" | "f64le" => value.to_bits().to_be_bytes(),
        _ => unreachable!(),
    };
    let source = &bits[8 - width..];
    bytes.with(|data| {
        let mut storage = data.storage.borrow_mut();
        let output = &mut storage[data.offset + offset..data.offset + offset + width];
        if kind.ends_with("le") {
            for (target, source) in output.iter_mut().zip(source.iter().rev()) {
                *target = *source;
            }
        } else {
            output.copy_from_slice(source);
        }
    });
    (offset + width) as f64
}

pub struct MapData<K: Clone + 'static, V: HeapValue> {
    entries: Vec<Option<(K, V)>>,
    live: usize,
    iteration_depth: usize,
}

impl<K: Clone + 'static, V: HeapValue> Trace for MapData<K, V> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for entry in &self.entries {
            if let Some((_, value)) = entry {
                value.trace_value(tracer);
            }
        }
    }
}

impl<K: Clone + 'static, V: HeapValue> ClearEdges for MapData<K, V> {
    fn clear_edges(&mut self) {
        self.entries.clear();
    }
}

pub type JsMap<K, V> = Gc<MapData<K, V>>;

pub fn map_new<K: Clone + 'static, V: HeapValue>() -> JsMap<K, V> {
    Gc::new(MapData {
        entries: Vec::new(),
        live: 0,
        iteration_depth: 0,
    })
}

pub fn map_set_by<K, V, F>(map: &JsMap<K, V>, key: K, value: V, equal: F)
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with_mut(|data| {
        if let Some((_, stored)) = data
            .entries
            .iter_mut()
            .flatten()
            .find(|(stored, _)| equal(stored, &key))
        {
            *stored = value;
        } else {
            data.entries.push(Some((key, value)));
            data.live += 1;
        }
    });
}

pub fn map_get_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> Option<V>
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with(|data| {
        data.entries
            .iter()
            .flatten()
            .find(|(stored, _)| equal(stored, key))
            .map(|(_, value)| value.clone())
    })
}

pub fn map_has_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> bool
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with(|data| {
        data.entries
            .iter()
            .flatten()
            .any(|(stored, _)| equal(stored, key))
    })
}

pub fn map_delete_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> bool
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with_mut(|data| {
        let Some(index) = data
            .entries
            .iter()
            .position(|entry| entry.as_ref().is_some_and(|(stored, _)| equal(stored, key)))
        else {
            return false;
        };
        data.entries[index] = None;
        data.live -= 1;
        if data.iteration_depth == 0 {
            data.entries.retain(Option::is_some);
        }
        true
    })
}

pub fn map_size<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) -> f64 {
    map.with(|data| data.live as f64)
}

pub fn map_clear<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| {
        data.live = 0;
        if data.iteration_depth == 0 {
            data.entries.clear();
        } else {
            for entry in &mut data.entries {
                *entry = None;
            }
        }
    });
}

pub fn map_iter_count<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) -> f64 {
    map.with(|data| data.entries.len() as f64)
}

pub fn map_iter_live<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> bool {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| data.entries[index].is_some())
}

pub fn map_iter_key<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> K {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| {
        data.entries[index]
            .as_ref()
            .expect("scriptc: map key read from a tombstone")
            .0
            .clone()
    })
}

pub fn map_iter_value<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> V {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| {
        data.entries[index]
            .as_ref()
            .expect("scriptc: map value read from a tombstone")
            .1
            .clone()
    })
}

pub fn map_iter_enter<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| data.iteration_depth += 1);
}

pub fn map_iter_exit<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| {
        data.iteration_depth = data
            .iteration_depth
            .checked_sub(1)
            .expect("scriptc: unbalanced map iteration exit");
        if data.iteration_depth == 0 {
            data.entries.retain(Option::is_some);
        }
    });
}

pub type JsSet<T> = JsMap<T, bool>;

pub fn set_new<T: Clone + 'static>() -> JsSet<T> {
    map_new()
}

pub fn set_from_array_by<T, N, F>(source: &JsArray<T>, normalize: N, equal: F) -> JsSet<T>
where
    T: ArrayElement,
    N: Fn(T) -> T,
    F: Fn(&T, &T) -> bool + Copy,
{
    let set = set_new();
    let values = source.with(|data| data.elements.clone());
    for value in values {
        map_set_by(&set, normalize(value), true, equal);
    }
    set
}

pub fn set_add_by<T, F>(set: &JsSet<T>, value: T, equal: F)
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_set_by(set, value, true, equal);
}

pub fn set_has_by<T, F>(set: &JsSet<T>, value: &T, equal: F) -> bool
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_has_by(set, value, equal)
}

pub fn set_delete_by<T, F>(set: &JsSet<T>, value: &T, equal: F) -> bool
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_delete_by(set, value, equal)
}

fn array_index(index: f64, allow_end: bool, len: usize) -> usize {
    if !index.is_finite() || index < 0.0 || index.fract() != 0.0 || index > usize::MAX as f64 {
        panic!("scriptc: invalid array index");
    }
    let index = index as usize;
    if index > len || (!allow_end && index == len) {
        panic!("scriptc: array index out of bounds");
    }
    index
}

pub fn empty_string() -> JsString {
    Rc::from("")
}

pub fn string(value: &str) -> JsString {
    Rc::from(value)
}

pub fn string_concat(left: &JsString, right: &JsString) -> JsString {
    let mut result = String::with_capacity(left.len() + right.len());
    result.push_str(left);
    result.push_str(right);
    Rc::from(result)
}

pub fn string_len(value: &JsString) -> f64 {
    value.encode_utf16().count() as f64
}

pub fn string_char_at(value: &JsString, index: f64) -> JsString {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if !index.is_finite() || index < 0.0 || index > usize::MAX as f64 {
        return empty_string();
    }
    let target = index as usize;
    let mut position = 0usize;
    for ch in value.chars() {
        let width = ch.len_utf16();
        if target == position {
            return if width == 1 {
                Rc::from(ch.to_string())
            } else {
                // Like the C runtime, safe UTF-8 storage cannot represent
                // the lone surrogate JavaScript returns for an astral half.
                string("\u{fffd}")
            };
        }
        if width == 2 && target == position + 1 {
            return string("\u{fffd}");
        }
        position += width;
    }
    empty_string()
}

pub fn string_char_code_at(value: &JsString, index: f64) -> f64 {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if !index.is_finite() || index < 0.0 || index > usize::MAX as f64 {
        return f64::NAN;
    }
    value
        .encode_utf16()
        .nth(index as usize)
        .map_or(f64::NAN, f64::from)
}

fn relative_string_index(index: f64, len: usize) -> usize {
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    if index == f64::NEG_INFINITY {
        return 0;
    }
    if index == f64::INFINITY {
        return len;
    }
    if index < 0.0 {
        (len as f64 + index).clamp(0.0, len as f64) as usize
    } else {
        index.clamp(0.0, len as f64) as usize
    }
}

pub fn string_index_of(value: &JsString, search: &JsString, from_index: f64) -> f64 {
    let haystack: Vec<u16> = value.encode_utf16().collect();
    let needle: Vec<u16> = search.encode_utf16().collect();
    let start = if from_index.is_nan() {
        0
    } else if from_index == f64::INFINITY {
        haystack.len()
    } else {
        from_index.trunc().clamp(0.0, haystack.len() as f64) as usize
    };
    if needle.is_empty() {
        return start as f64;
    }
    haystack[start..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map_or(-1.0, |index| (start + index) as f64)
}

pub fn string_slice(value: &JsString, start: f64, end: f64) -> JsString {
    let units: Vec<u16> = value.encode_utf16().collect();
    let start = relative_string_index(start, units.len());
    let end = relative_string_index(end, units.len());
    if end <= start {
        return empty_string();
    }
    Rc::from(String::from_utf16_lossy(&units[start..end]))
}

pub fn string_repeat(value: &JsString, count: f64) -> JsString {
    let count = if count.is_nan() { 0.0 } else { count.trunc() };
    if !count.is_finite() || count < 0.0 {
        panic!("RangeError: Invalid count value");
    }
    Rc::<str>::from(value.repeat(count as usize))
}

pub fn string_to_lower_case(value: &JsString) -> JsString {
    Rc::<str>::from(value.to_lowercase())
}

pub fn string_to_upper_case(value: &JsString) -> JsString {
    Rc::<str>::from(value.to_uppercase())
}

pub fn string_includes(value: &JsString, search: &JsString, from_index: f64) -> bool {
    string_index_of(value, search, from_index) >= 0.0
}

pub fn string_starts_with(value: &JsString, search: &JsString) -> bool {
    value.starts_with(search.as_ref())
}

pub fn string_ends_with(value: &JsString, search: &JsString) -> bool {
    value.ends_with(search.as_ref())
}

fn javascript_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub fn string_trim(value: &JsString) -> JsString {
    Rc::from(value.trim_matches(javascript_whitespace))
}

pub fn string_split(value: &JsString, separator: &JsString, limit: f64) -> JsArray<JsString> {
    let limit = to_uint32(limit) as usize;
    if limit == 0 {
        return array_new(Vec::new());
    }
    let parts = if separator.is_empty() {
        value
            .encode_utf16()
            .take(limit)
            .map(|unit| Rc::from(String::from_utf16_lossy(&[unit])))
            .collect()
    } else {
        value
            .split(separator.as_ref())
            .take(limit)
            .map(Rc::<str>::from)
            .collect()
    };
    array_new(parts)
}

pub fn process_argv() -> JsArray<JsString> {
    PROCESS_ARGV.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some(argv) = slot.as_ref() {
            return argv.clone();
        }
        let mut native = std::env::args();
        let executable = native.next().unwrap_or_else(|| "scriptc".to_owned());
        let mut values = vec![Rc::from(executable.as_str()), Rc::from(executable.as_str())];
        values.extend(native.map(Rc::<str>::from));
        let argv = array_new(values);
        *slot = Some(argv.clone());
        argv
    })
}

pub fn process_platform() -> JsString {
    string(if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    })
}

pub fn process_cwd() -> JsString {
    Rc::from(
        std::env::current_dir()
            .expect("scriptc: current directory is unavailable")
            .to_string_lossy()
            .as_ref(),
    )
}

pub fn process_pid() -> f64 {
    f64::from(std::process::id())
}

fn process_status_id(prefix: &str, id_flag: &str) -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                line.strip_prefix(prefix)?
                    .split_whitespace()
                    .next()?
                    .parse::<f64>()
                    .ok()
            })
        })
        .or_else(|| {
            let output = std::process::Command::new("id")
                .arg(id_flag)
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<f64>()
                .ok()
        })
        .unwrap_or(0.0)
}

pub fn process_getuid() -> f64 {
    process_status_id("Uid:", "-u")
}

pub fn process_getgid() -> f64 {
    process_status_id("Gid:", "-g")
}

pub fn process_exec_path() -> JsString {
    Rc::from(
        std::env::current_exe()
            .expect("scriptc: executable path is unavailable")
            .to_string_lossy()
            .as_ref(),
    )
}

pub fn process_arch() -> JsString {
    string(if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86") {
        "ia32"
    } else {
        std::env::consts::ARCH
    })
}

pub fn process_env_get(name: &JsString) -> Option<JsString> {
    std::env::var_os(name.as_ref()).map(|value| Rc::from(value.to_string_lossy().as_ref()))
}

pub fn process_versions_node() -> JsString {
    string("24.0.0")
}

pub fn process_versions_openssl() -> JsString {
    string("3.5.5")
}

pub fn number_parse_int(value: &JsString, radix: f64) -> f64 {
    let trimmed = value.trim_start_matches(javascript_whitespace);
    let (negative, mut digits) = if let Some(rest) = trimmed.strip_prefix('-') {
        (true, rest)
    } else if let Some(rest) = trimmed.strip_prefix('+') {
        (false, rest)
    } else {
        (false, trimmed)
    };
    let requested = to_int32(radix);
    if requested != 0 && !(2..=36).contains(&requested) {
        return f64::NAN;
    }
    let mut base = if requested == 0 { 10 } else { requested };
    if (requested == 0 || requested == 16) && (digits.starts_with("0x") || digits.starts_with("0X"))
    {
        digits = &digits[2..];
        base = 16;
    }
    let mut result = 0.0;
    let mut consumed = false;
    let mut consumed_bytes = 0;
    for byte in digits.bytes() {
        let digit = match byte {
            b'0'..=b'9' => i32::from(byte - b'0'),
            b'a'..=b'z' => i32::from(byte - b'a') + 10,
            b'A'..=b'Z' => i32::from(byte - b'A') + 10,
            _ => break,
        };
        if digit >= base {
            break;
        }
        consumed = true;
        consumed_bytes += 1;
        result = result * f64::from(base) + f64::from(digit);
    }
    if !consumed {
        return f64::NAN;
    }
    // Rust's decimal parser performs correctly-rounded conversion over the
    // full digit sequence; repeated f64 multiplication can drift by one ULP
    // for large decimal integers (unlike JavaScript's parseInt result).
    if base == 10 {
        result = digits[..consumed_bytes]
            .parse::<f64>()
            .unwrap_or(f64::INFINITY);
    }
    if negative { -result } else { result }
}

fn fs_error_code(error: &std::io::Error) -> &'static str {
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

fn throw_fs_error(operation: &str, path: &JsString, error: std::io::Error) -> ! {
    let code = fs_error_code(&error);
    throw_value(JsError {
        name: "Error".to_owned(),
        message: format!("{code}: {error}, {operation} '{}'", path),
        code: Some(code.to_owned()),
    })
}

fn throw_fs_error2(operation: &str, from: &JsString, to: &JsString, error: std::io::Error) -> ! {
    let code = fs_error_code(&error);
    throw_value(JsError {
        name: "Error".to_owned(),
        message: format!("{code}: {error}, {operation} '{from}' -> '{to}'"),
        code: Some(code.to_owned()),
    })
}

fn throw_fs_fd_error(operation: &str, code: &str, description: &str) -> ! {
    throw_value(JsError {
        name: "Error".to_owned(),
        message: format!("{code}: {description}, {operation}"),
        code: Some(code.to_owned()),
    })
}

fn throw_fs_fd_io_error(operation: &str, error: std::io::Error) -> ! {
    let code = fs_error_code(&error);
    throw_fs_fd_error(operation, code, &error.to_string())
}

fn throw_out_of_range(message: String) -> ! {
    throw_value(JsError {
        name: "RangeError".to_owned(),
        message,
        code: Some("ERR_OUT_OF_RANGE".to_owned()),
    })
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

pub fn os_tmpdir() -> JsString {
    let value = std::env::var_os("TMPDIR")
        .or_else(|| std::env::var_os("TMP"))
        .or_else(|| std::env::var_os("TEMP"))
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "."
            } else {
                "/tmp"
            }
            .to_owned()
        });
    let trimmed = if value.len() > 1 {
        value.trim_end_matches(['/', '\\'])
    } else {
        value.as_str()
    };
    Rc::from(trimmed)
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
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(to_uint32(mode))
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
pub fn fs_write_file_mode(path: &JsString, data: &JsString, _mode: f64) {
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
        _ => throw_type_error(format!(
            "The argument 'flags' is invalid. Received '{flags}'"
        )),
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
    with_open_file(fd, "read", |file| file.read_to_end(&mut output));
    bytes_from_vec(output)
}

pub fn fs_read_fd(fd: f64, _encoding: &JsString) -> JsString {
    let bytes = fs_read_fd_bytes(fd);
    bytes_to_string(&bytes, &string("utf8"))
}

struct SyncChildOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
}

fn run_sync_child(
    mut command: std::process::Command,
    input: Option<&[u8]>,
    timeout_ms: f64,
) -> std::io::Result<SyncChildOutput> {
    use std::io::{Read, Write};

    let mut child = command.spawn()?;
    let stdout_reader = child.stdout.take().map(|mut stdout| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).map(|_| bytes)
        })
    });
    let stderr_reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).map(|_| bytes)
        })
    });
    if let Some(input) = input {
        if let Err(error) = child
            .stdin
            .take()
            .expect("scriptc: piped child stdin missing")
            .write_all(input)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    }
    let timeout = if timeout_ms.is_finite() && timeout_ms > 0.0 {
        Some(std::time::Duration::from_secs_f64(timeout_ms / 1000.0))
    } else {
        None
    };
    let started = std::time::Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if timeout.is_some_and(|timeout| started.elapsed() >= timeout) => {
                timed_out = true;
                let _ = child.kill();
                break child.wait()?;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(1)),
        }
    };
    let join_reader = |reader: Option<std::thread::JoinHandle<std::io::Result<Vec<u8>>>>| {
        reader.map_or_else(
            || Ok(Vec::new()),
            |reader| match reader.join() {
                Ok(result) => result,
                Err(_) => Err(std::io::Error::other("child output reader panicked")),
            },
        )
    };
    Ok(SyncChildOutput {
        status,
        stdout: join_reader(stdout_reader)?,
        stderr: join_reader(stderr_reader)?,
        timed_out,
    })
}

pub fn child_exec_sync(
    command: &JsString,
    arguments: &JsArray<JsString>,
    shell: bool,
    input: &JsString,
    has_input: bool,
    cwd: &JsString,
    has_env: bool,
    env_pairs: &JsArray<JsString>,
    timeout_ms: f64,
    stdout_mode: f64,
    stderr_mode: f64,
) -> JsString {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child_command = Command::new(command.as_ref());
    arguments.with(|arguments| {
        child_command.args(arguments.elements.iter().map(|value| value.as_ref()));
    });
    if !cwd.is_empty() {
        child_command.current_dir(cwd.as_ref());
    }
    if has_env {
        child_command.env_clear();
        env_pairs.with(|pairs| {
            for pair in pairs.elements.chunks_exact(2) {
                child_command.env(pair[0].as_ref(), pair[1].as_ref());
            }
        });
    }

    let stdout_mode = to_int32(stdout_mode);
    let stdin_inherit = stdout_mode & 4 != 0;
    let stdout_mode = stdout_mode & 3;
    child_command.stdin(if has_input {
        Stdio::piped()
    } else if stdin_inherit {
        Stdio::inherit()
    } else {
        Stdio::null()
    });
    child_command.stdout(match stdout_mode {
        0 => Stdio::null(),
        2 => Stdio::inherit(),
        _ => Stdio::piped(),
    });
    let stderr_mode = to_int32(stderr_mode);
    child_command.stderr(match stderr_mode {
        2 => Stdio::null(),
        3 => Stdio::inherit(),
        _ => Stdio::piped(),
    });

    let output = match run_sync_child(
        child_command,
        has_input.then_some(input.as_bytes()),
        timeout_ms,
    ) {
        Ok(output) => output,
        Err(error) => {
            let code = fs_error_code(&error);
            throw_value(JsError {
                name: "Error".to_owned(),
                message: format!("spawnSync {command} {code}"),
                code: Some(code.to_owned()),
            })
        }
    };
    if stderr_mode == 0 {
        let _ = std::io::stderr().write_all(&output.stderr);
    }
    if output.timed_out {
        throw_value(JsError {
            name: "Error".to_owned(),
            message: format!("spawnSync {command} ETIMEDOUT"),
            code: Some("ETIMEDOUT".to_owned()),
        });
    }
    if !output.status.success() {
        let display = if shell {
            arguments.with(|arguments| {
                arguments
                    .elements
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| command.clone())
            })
        } else {
            let mut display = command.to_string();
            arguments.with(|arguments| {
                for argument in &arguments.elements {
                    display.push(' ');
                    display.push_str(argument);
                }
            });
            Rc::from(display)
        };
        let stderr = String::from_utf8_lossy(&output.stderr);
        throw_value(JsError {
            name: "Error".to_owned(),
            message: format!("Command failed: {display}\n{stderr}"),
            code: None,
        });
    }
    Rc::from(String::from_utf8_lossy(&output.stdout).as_ref())
}

pub struct SpawnResultData {
    status: Option<f64>,
    signal: Option<JsString>,
    stdout: JsString,
    stderr: JsString,
    error: Option<JsError>,
}

impl Trace for SpawnResultData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for SpawnResultData {
    fn clear_edges(&mut self) {}
}

pub type JsSpawnResult = Gc<SpawnResultData>;

#[cfg(unix)]
fn child_exit_signal(status: &std::process::ExitStatus) -> Option<JsString> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| {
        string(match signal {
            1 => "SIGHUP",
            2 => "SIGINT",
            3 => "SIGQUIT",
            4 => "SIGILL",
            6 => "SIGABRT",
            9 => "SIGKILL",
            11 => "SIGSEGV",
            13 => "SIGPIPE",
            14 => "SIGALRM",
            15 => "SIGTERM",
            _ => "SIGUNKNOWN",
        })
    })
}

#[cfg(not(unix))]
fn child_exit_signal(_status: &std::process::ExitStatus) -> Option<JsString> {
    None
}

pub fn child_spawn_sync(
    command: &JsString,
    arguments: &JsArray<JsString>,
    timeout_ms: f64,
    kill_signal: &JsString,
    stdin_mode: f64,
    stdout_mode: f64,
    stderr_mode: f64,
) -> JsSpawnResult {
    use std::process::{Command, Stdio};

    let mut child_command = Command::new(command.as_ref());
    arguments.with(|arguments| {
        child_command.args(arguments.elements.iter().map(|value| value.as_ref()));
    });
    child_command.stdin(if to_int32(stdin_mode) == 2 {
        Stdio::inherit()
    } else {
        Stdio::null()
    });
    child_command.stdout(match to_int32(stdout_mode) {
        1 => Stdio::null(),
        2 => Stdio::inherit(),
        _ => Stdio::piped(),
    });
    child_command.stderr(match to_int32(stderr_mode) {
        1 => Stdio::null(),
        2 => Stdio::inherit(),
        _ => Stdio::piped(),
    });

    match run_sync_child(child_command, None, timeout_ms) {
        Err(error) => {
            let code = fs_error_code(&error);
            Gc::new(SpawnResultData {
                status: None,
                signal: None,
                stdout: string(""),
                stderr: string(""),
                error: Some(JsError {
                    name: "Error".to_owned(),
                    message: format!("spawnSync {command} {code}"),
                    code: Some(code.to_owned()),
                }),
            })
        }
        Ok(output) => {
            let signal = if output.timed_out {
                Some(if kill_signal.is_empty() {
                    string("SIGTERM")
                } else {
                    kill_signal.clone()
                })
            } else {
                child_exit_signal(&output.status)
            };
            Gc::new(SpawnResultData {
                status: if output.timed_out {
                    None
                } else {
                    output.status.code().map(f64::from)
                },
                signal,
                stdout: Rc::from(String::from_utf8_lossy(&output.stdout).as_ref()),
                stderr: Rc::from(String::from_utf8_lossy(&output.stderr).as_ref()),
                error: output.timed_out.then(|| JsError {
                    name: "Error".to_owned(),
                    message: format!("spawnSync {command} ETIMEDOUT"),
                    code: Some("ETIMEDOUT".to_owned()),
                }),
            })
        }
    }
}

pub fn child_spawn_sync_stdio(
    command: &JsString,
    arguments: &JsArray<JsString>,
    timeout_ms: f64,
    kill_signal: &JsString,
    stdio: &JsString,
) -> JsSpawnResult {
    let (stdin_mode, stdout_mode, stderr_mode) = match stdio.as_ref() {
        "pipe" => (0.0, 0.0, 0.0),
        "ignore" => (0.0, 1.0, 1.0),
        "inherit" => (2.0, 2.0, 2.0),
        other => throw_type_error(format!(
            "spawnSync stdio \"{other}\" has no static lowering"
        )),
    };
    child_spawn_sync(
        command,
        arguments,
        timeout_ms,
        kill_signal,
        stdin_mode,
        stdout_mode,
        stderr_mode,
    )
}

pub fn spawn_result_status(result: &JsSpawnResult) -> Option<f64> {
    result.with(|result| result.status)
}

pub fn spawn_result_signal(result: &JsSpawnResult) -> Option<JsString> {
    result.with(|result| result.signal.clone())
}

pub fn spawn_result_stdout(result: &JsSpawnResult) -> JsString {
    result.with(|result| result.stdout.clone())
}

pub fn spawn_result_stderr(result: &JsSpawnResult) -> JsString {
    result.with(|result| result.stderr.clone())
}

pub fn spawn_result_error(result: &JsSpawnResult) -> Option<JsError> {
    result.with(|result| result.error.clone())
}

pub struct StatsData {
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
    size: f64,
    blocks: f64,
    nlink: f64,
    atime_ms: f64,
    mtime_ms: f64,
}

impl Trace for StatsData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for StatsData {
    fn clear_edges(&mut self) {}
}

pub type JsStats = Gc<StatsData>;

fn system_time_ms(value: std::io::Result<std::time::SystemTime>) -> f64 {
    match value {
        Ok(value) => match value.duration_since(std::time::UNIX_EPOCH) {
            Ok(duration) => duration.as_secs_f64() * 1000.0,
            Err(error) => -error.duration().as_secs_f64() * 1000.0,
        },
        Err(_) => 0.0,
    }
}

#[cfg(unix)]
fn stats_platform_fields(metadata: &std::fs::Metadata) -> (f64, f64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.blocks() as f64, metadata.nlink() as f64)
}

#[cfg(not(unix))]
fn stats_platform_fields(_metadata: &std::fs::Metadata) -> (f64, f64) {
    (0.0, 1.0)
}

pub fn fs_stat(path: &JsString, follow: bool) -> JsStats {
    let result = if follow {
        std::fs::metadata(path.as_ref())
    } else {
        std::fs::symlink_metadata(path.as_ref())
    };
    let metadata = match result {
        Ok(metadata) => metadata,
        Err(error) => throw_fs_error(if follow { "stat" } else { "lstat" }, path, error),
    };
    let (blocks, nlink) = stats_platform_fields(&metadata);
    Gc::new(StatsData {
        is_file: metadata.is_file(),
        is_directory: metadata.is_dir(),
        is_symlink: metadata.file_type().is_symlink(),
        size: metadata.len() as f64,
        blocks,
        nlink,
        atime_ms: system_time_ms(metadata.accessed()),
        mtime_ms: system_time_ms(metadata.modified()),
    })
}

pub fn stats_is_file(stats: &JsStats) -> bool {
    stats.with(|stats| stats.is_file)
}
pub fn stats_is_directory(stats: &JsStats) -> bool {
    stats.with(|stats| stats.is_directory)
}
pub fn stats_is_symlink(stats: &JsStats) -> bool {
    stats.with(|stats| stats.is_symlink)
}
pub fn stats_size(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.size)
}
pub fn stats_blocks(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.blocks)
}
pub fn stats_nlink(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.nlink)
}
pub fn stats_atime_ms(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.atime_ms)
}
pub fn stats_mtime_ms(stats: &JsStats) -> f64 {
    stats.with(|stats| stats.mtime_ms)
}

fn normalize_posix(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push(part);
                }
            }
            _ => parts.push(part),
        }
    }
    let mut result = parts.join("/");
    if result.is_empty() && !absolute {
        result.push('.');
    }
    if trailing && !result.is_empty() && result != "/" {
        result.push('/');
    }
    if absolute {
        result.insert(0, '/');
    }
    result
}

pub fn path_normalize(path: &JsString) -> JsString {
    Rc::from(normalize_posix(path))
}

pub fn path_join(parts: &JsArray<JsString>) -> JsString {
    let joined = parts.with(|data| {
        data.elements
            .iter()
            .filter(|part| !part.is_empty())
            .map(|part| part.as_ref())
            .collect::<Vec<_>>()
            .join("/")
    });
    Rc::from(normalize_posix(&joined))
}

pub fn path_resolve(parts: &JsArray<JsString>) -> JsString {
    let mut inputs = parts.with(|data| {
        data.elements
            .iter()
            .map(|part| part.to_string())
            .collect::<Vec<_>>()
    });
    inputs.insert(0, process_cwd().to_string());
    let mut combined = String::new();
    for part in inputs.iter().rev() {
        if part.is_empty() {
            continue;
        }
        combined = if combined.is_empty() {
            part.clone()
        } else {
            format!("{part}/{combined}")
        };
        if part.starts_with('/') {
            break;
        }
    }
    let mut normalized = normalize_posix(&combined);
    if normalized.len() > 1 {
        normalized.truncate(normalized.trim_end_matches('/').len());
    }
    Rc::from(if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    })
}

pub fn path_is_absolute(path: &JsString) -> bool {
    path.starts_with('/')
}

pub fn path_dirname(path: &JsString) -> JsString {
    let bytes = path.as_bytes();
    if bytes.is_empty() {
        return string(".");
    }
    let root = bytes[0] == b'/';
    let mut end = None;
    let mut matched_slash = true;
    for index in (1..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                end = Some(index);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None => string(if root { "/" } else { "." }),
        Some(1) if root => string("//"),
        Some(end) => Rc::from(&path[..end]),
    }
}

pub fn path_basename(path: &JsString, suffix: &JsString) -> JsString {
    let trimmed = path.trim_end_matches('/');
    if !suffix.is_empty() && trimmed == suffix.as_ref() {
        return empty_string();
    }
    let mut basename = trimmed.rsplit('/').next().unwrap_or("");
    if !suffix.is_empty() && suffix.len() < basename.len() && basename.ends_with(suffix.as_ref()) {
        basename = &basename[..basename.len() - suffix.len()];
    }
    Rc::from(basename)
}

pub fn path_extname(path: &JsString) -> JsString {
    let basename = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let Some(dot) = basename.rfind('.') else {
        return empty_string();
    };
    if dot == 0 || basename == ".." {
        return empty_string();
    }
    Rc::from(&basename[dot..])
}

pub fn path_relative(from: &JsString, to: &JsString) -> JsString {
    let from_parts = path_resolve(&array_new(vec![from.clone()]));
    let to_parts = path_resolve(&array_new(vec![to.clone()]));
    let from_parts: Vec<_> = from_parts
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let to_parts: Vec<_> = to_parts
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let common = from_parts
        .iter()
        .zip(&to_parts)
        .take_while(|(left, right)| left == right)
        .count();
    let mut result = vec![".."; from_parts.len() - common];
    result.extend(to_parts[common..].iter().copied());
    Rc::from(result.join("/"))
}

pub fn number_to_string(value: f64) -> JsString {
    Rc::from(format_number(value))
}

pub fn number_is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

pub fn number_is_safe_integer(value: f64) -> bool {
    number_is_integer(value) && value.abs() <= 9_007_199_254_740_991.0
}

pub fn bool_to_string(value: bool) -> JsString {
    string(if value { "true" } else { "false" })
}

pub trait JsonValue {
    fn write_json(&self, writer: &mut JsonWriter);

    fn is_json_undefined(&self) -> bool {
        false
    }
}

pub trait JsonObject: Trace + ClearEdges + 'static {
    fn write_json_object(&self, writer: &mut JsonWriter);
}

pub struct JsonWriter {
    output: String,
    stack: HashSet<usize>,
}

impl JsonWriter {
    fn new() -> Self {
        Self {
            output: String::new(),
            stack: HashSet::new(),
        }
    }

    pub fn begin_array(&mut self) {
        self.output.push('[');
    }

    pub fn end_array(&mut self) {
        self.output.push(']');
    }

    pub fn begin_object(&mut self) {
        self.output.push('{');
    }

    pub fn end_object(&mut self) {
        self.output.push('}');
    }

    pub fn element<T: JsonValue>(&mut self, first: &mut bool, value: &T) {
        if !*first {
            self.output.push(',');
        }
        *first = false;
        value.write_json(self);
    }

    pub fn property<T: JsonValue>(&mut self, first: &mut bool, name: &str, value: &T) {
        if value.is_json_undefined() {
            return;
        }
        if !*first {
            self.output.push(',');
        }
        *first = false;
        self.write_string(name);
        self.output.push(':');
        value.write_json(self);
    }

    pub fn write_null(&mut self) {
        self.output.push_str("null");
    }

    fn write_string(&mut self, value: &str) {
        self.output.push('"');
        for ch in value.chars() {
            match ch {
                '"' => self.output.push_str("\\\""),
                '\\' => self.output.push_str("\\\\"),
                '\u{0008}' => self.output.push_str("\\b"),
                '\u{000c}' => self.output.push_str("\\f"),
                '\n' => self.output.push_str("\\n"),
                '\r' => self.output.push_str("\\r"),
                '\t' => self.output.push_str("\\t"),
                '\u{0000}'..='\u{001f}' => {
                    self.output.push_str(&format!("\\u{:04x}", ch as u32));
                }
                _ => self.output.push(ch),
            }
        }
        self.output.push('"');
    }
}

impl JsonValue for f64 {
    fn write_json(&self, writer: &mut JsonWriter) {
        if self.is_finite() {
            writer.output.push_str(&format_number(*self));
        } else {
            writer.write_null();
        }
    }
}

impl JsonValue for bool {
    fn write_json(&self, writer: &mut JsonWriter) {
        writer.output.push_str(if *self { "true" } else { "false" });
    }
}

impl JsonValue for JsString {
    fn write_json(&self, writer: &mut JsonWriter) {
        writer.write_string(self);
    }
}

impl<T> JsonValue for Gc<T>
where
    T: JsonObject,
{
    fn write_json(&self, writer: &mut JsonWriter) {
        let id = self.identity();
        if !writer.stack.insert(id) {
            throw_type_error("Converting circular structure to JSON".to_owned());
        }
        self.with(|value| value.write_json_object(writer));
        assert!(writer.stack.remove(&id));
    }
}

impl<T> JsonObject for ArrayData<T>
where
    T: ArrayElement + JsonValue,
{
    fn write_json_object(&self, writer: &mut JsonWriter) {
        writer.begin_array();
        let mut first = true;
        for value in &self.elements {
            writer.element(&mut first, value);
        }
        writer.end_array();
    }
}

pub fn json_stringify<T: JsonValue>(value: &T) -> JsString {
    let mut writer = JsonWriter::new();
    value.write_json(&mut writer);
    Rc::from(writer.output)
}

pub enum JsonNode {
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<JsonNode>),
    Object(Vec<(String, JsonNode)>),
}

impl JsonNode {
    fn kind(&self) -> &'static str {
        match self {
            Self::Null => "null",
            Self::Bool(_) => "boolean",
            Self::Number(_) => "number",
            Self::String(_) => "string",
            Self::Array(_) => "array",
            Self::Object(_) => "object",
        }
    }
}

pub trait JsonDecode: Sized {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String>;
}

pub trait JsonObjectDecode: Trace + ClearEdges + Sized + 'static {
    fn decode_json_object(node: &JsonNode, path: &str) -> Result<Self, String>;
}

pub fn json_type_error(path: &str, expected: &str, node: &JsonNode) -> String {
    format!("expected {expected} at {path}, got {}", node.kind())
}

pub fn json_property_path(path: &str, property: &str) -> String {
    format!("{path}.{property}")
}

pub fn json_index_path(path: &str, index: usize) -> String {
    format!("{path}[{index}]")
}

pub fn json_expect_object<'a>(
    node: &'a JsonNode,
    path: &str,
) -> Result<&'a [(String, JsonNode)], String> {
    match node {
        JsonNode::Object(fields) => Ok(fields),
        _ => Err(json_type_error(path, "object", node)),
    }
}

pub fn json_expect_array<'a>(node: &'a JsonNode, path: &str) -> Result<&'a [JsonNode], String> {
    match node {
        JsonNode::Array(elements) => Ok(elements),
        _ => Err(json_type_error(path, "array", node)),
    }
}

pub fn json_object_field<'a>(object: &'a [(String, JsonNode)], name: &str) -> Option<&'a JsonNode> {
    object
        .iter()
        .rev()
        .find_map(|(key, value)| (key == name).then_some(value))
}

pub fn json_required_field<'a>(
    object: &'a [(String, JsonNode)],
    name: &str,
    path: &str,
) -> Result<&'a JsonNode, String> {
    json_object_field(object, name).ok_or_else(|| format!("expected property '{}' at {path}", name))
}

impl JsonDecode for f64 {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::Number(value) => Ok(*value),
            _ => Err(json_type_error(path, "number", node)),
        }
    }
}

impl JsonDecode for bool {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::Bool(value) => Ok(*value),
            _ => Err(json_type_error(path, "boolean", node)),
        }
    }
}

impl JsonDecode for JsString {
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        match node {
            JsonNode::String(value) => Ok(value.clone()),
            _ => Err(json_type_error(path, "string", node)),
        }
    }
}

impl<T> JsonDecode for Gc<T>
where
    T: JsonObjectDecode,
{
    fn decode_json(node: &JsonNode, path: &str) -> Result<Self, String> {
        Ok(Gc::new(T::decode_json_object(node, path)?))
    }
}

impl<T> JsonObjectDecode for ArrayData<T>
where
    T: ArrayElement + JsonDecode,
{
    fn decode_json_object(node: &JsonNode, path: &str) -> Result<Self, String> {
        let elements = json_expect_array(node, path)?;
        let mut decoded = Vec::with_capacity(elements.len());
        for (index, element) in elements.iter().enumerate() {
            decoded.push(T::decode_json(element, &json_index_path(path, index))?);
        }
        Ok(Self { elements: decoded })
    }
}

pub fn json_parse_typed<T: JsonDecode>(text: &JsString) -> T {
    let node = JsonParser::new(text)
        .parse()
        .unwrap_or_else(|message| throw_syntax_error(message));
    T::decode_json(&node, "$").unwrap_or_else(|message| throw_type_error(message))
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> JsonParser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            position: 0,
        }
    }

    fn parse(mut self) -> Result<JsonNode, String> {
        self.whitespace();
        let value = self.value()?;
        self.whitespace();
        if self.position != self.bytes.len() {
            return self.syntax("unexpected trailing input");
        }
        Ok(value)
    }

    fn value(&mut self) -> Result<JsonNode, String> {
        self.whitespace();
        match self.peek() {
            Some(b'n') => {
                self.keyword(b"null")?;
                Ok(JsonNode::Null)
            }
            Some(b't') => {
                self.keyword(b"true")?;
                Ok(JsonNode::Bool(true))
            }
            Some(b'f') => {
                self.keyword(b"false")?;
                Ok(JsonNode::Bool(false))
            }
            Some(b'"') => Ok(JsonNode::String(Rc::from(self.string()?))),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.syntax("unexpected token"),
        }
    }

    fn array(&mut self) -> Result<JsonNode, String> {
        self.position += 1;
        self.whitespace();
        let mut elements = Vec::new();
        if self.take(b']') {
            return Ok(JsonNode::Array(elements));
        }
        loop {
            elements.push(self.value()?);
            self.whitespace();
            if self.take(b']') {
                return Ok(JsonNode::Array(elements));
            }
            if !self.take(b',') {
                return self.syntax("expected ',' or ']'");
            }
        }
    }

    fn object(&mut self) -> Result<JsonNode, String> {
        self.position += 1;
        self.whitespace();
        let mut fields = Vec::new();
        if self.take(b'}') {
            return Ok(JsonNode::Object(fields));
        }
        loop {
            self.whitespace();
            if self.peek() != Some(b'"') {
                return self.syntax("expected a string property name");
            }
            let name = self.string()?;
            self.whitespace();
            if !self.take(b':') {
                return self.syntax("expected ':'");
            }
            fields.push((name, self.value()?));
            self.whitespace();
            if self.take(b'}') {
                return Ok(JsonNode::Object(fields));
            }
            if !self.take(b',') {
                return self.syntax("expected ',' or '}'");
            }
        }
    }

    fn number(&mut self) -> Result<JsonNode, String> {
        let start = self.position;
        self.take(b'-');
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => {
                self.position += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return self.syntax("invalid number"),
        }
        if self.take(b'.') {
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.syntax("invalid number fraction");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return self.syntax("invalid number exponent");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        let spelling = std::str::from_utf8(&self.bytes[start..self.position])
            .map_err(|_| "invalid UTF-8 in JSON number".to_owned())?;
        let value = spelling
            .parse::<f64>()
            .map_err(|_| format!("invalid JSON number at byte {start}"))?;
        Ok(JsonNode::Number(value))
    }

    fn string(&mut self) -> Result<String, String> {
        debug_assert_eq!(self.peek(), Some(b'"'));
        self.position += 1;
        let mut output = String::new();
        loop {
            let Some(byte) = self.peek() else {
                return self.syntax("unterminated string");
            };
            match byte {
                b'"' => {
                    self.position += 1;
                    return Ok(output);
                }
                b'\\' => {
                    self.position += 1;
                    let escaped = self
                        .peek()
                        .ok_or_else(|| format!("unterminated escape at byte {}", self.position))?;
                    self.position += 1;
                    match escaped {
                        b'"' => output.push('"'),
                        b'\\' => output.push('\\'),
                        b'/' => output.push('/'),
                        b'b' => output.push('\u{0008}'),
                        b'f' => output.push('\u{000c}'),
                        b'n' => output.push('\n'),
                        b'r' => output.push('\r'),
                        b't' => output.push('\t'),
                        b'u' => {
                            let first = self.hex_quad()?;
                            if (0xd800..=0xdbff).contains(&first)
                                && self.bytes.get(self.position..self.position + 2) == Some(b"\\u")
                            {
                                self.position += 2;
                                let second = self.hex_quad()?;
                                if (0xdc00..=0xdfff).contains(&second) {
                                    let scalar = 0x10000
                                        + (((first as u32 - 0xd800) << 10)
                                            | (second as u32 - 0xdc00));
                                    output.push(
                                        char::from_u32(scalar).expect("valid JSON surrogate pair"),
                                    );
                                } else {
                                    output.push('\u{fffd}');
                                    output
                                        .push(char::from_u32(second as u32).unwrap_or('\u{fffd}'));
                                }
                            } else {
                                output.push(char::from_u32(first as u32).unwrap_or('\u{fffd}'));
                            }
                        }
                        _ => return self.syntax("invalid string escape"),
                    }
                }
                0x00..=0x1f => return self.syntax("unescaped control character in string"),
                _ => {
                    let tail = std::str::from_utf8(&self.bytes[self.position..])
                        .map_err(|_| format!("invalid UTF-8 at byte {}", self.position))?;
                    let ch = tail.chars().next().expect("non-empty JSON input tail");
                    output.push(ch);
                    self.position += ch.len_utf8();
                }
            }
        }
    }

    fn hex_quad(&mut self) -> Result<u16, String> {
        let start = self.position;
        let end = start.saturating_add(4);
        let Some(bytes) = self.bytes.get(start..end) else {
            return self.syntax("incomplete unicode escape");
        };
        let spelling = std::str::from_utf8(bytes).expect("ASCII JSON unicode escape");
        let value = u16::from_str_radix(spelling, 16)
            .map_err(|_| format!("invalid unicode escape at byte {start}"))?;
        self.position = end;
        Ok(value)
    }

    fn keyword(&mut self, keyword: &[u8]) -> Result<(), String> {
        if self.bytes.get(self.position..self.position + keyword.len()) != Some(keyword) {
            return self.syntax("unexpected token");
        }
        self.position += keyword.len();
        Ok(())
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.position += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn take(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn syntax<T>(&self, message: &str) -> Result<T, String> {
        Err(format!("{message} at byte {}", self.position))
    }
}

pub fn format_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value == f64::INFINITY {
        return "Infinity".to_owned();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if !(1e-6..1e21).contains(&magnitude) {
        let scientific = format!("{value:e}");
        let (mantissa, exponent) = scientific
            .split_once('e')
            .expect("scriptc: Rust scientific number without an exponent");
        let exponent = exponent
            .parse::<i32>()
            .expect("scriptc: invalid Rust scientific exponent");
        return format!(
            "{mantissa}e{}{exponent}",
            if exponent >= 0 { "+" } else { "" }
        );
    }
    value.to_string()
}

pub fn display_string(value: &JsString) -> String {
    value.to_string()
}

pub fn display_number(value: f64) -> String {
    if value == 0.0 && value.is_sign_negative() {
        "-0".to_owned()
    } else {
        format_number(value)
    }
}

pub fn display_bool(value: bool) -> String {
    if value { "true" } else { "false" }.to_owned()
}

pub fn number_same_value(left: f64, right: f64) -> bool {
    if left.is_nan() && right.is_nan() {
        return true;
    }
    if left == 0.0 && right == 0.0 {
        return left.is_sign_negative() == right.is_sign_negative();
    }
    left == right
}

pub fn console_log(values: &[String]) {
    println!("{}", values.join(" "));
}

pub fn console_error(values: &[String]) {
    eprintln!("{}", values.join(" "));
}

pub fn to_int32(value: f64) -> i32 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    let truncated = value.trunc();
    let modulo = truncated.rem_euclid(4_294_967_296.0);
    if modulo >= 2_147_483_648.0 {
        (modulo - 4_294_967_296.0) as i32
    } else {
        modulo as i32
    }
}

pub fn to_uint32(value: f64) -> u32 {
    to_int32(value) as u32
}

pub fn bit_not(value: f64) -> f64 {
    (!to_int32(value)) as f64
}

pub fn bit_and(left: f64, right: f64) -> f64 {
    (to_int32(left) & to_int32(right)) as f64
}

pub fn bit_or(left: f64, right: f64) -> f64 {
    (to_int32(left) | to_int32(right)) as f64
}

pub fn bit_xor(left: f64, right: f64) -> f64 {
    (to_int32(left) ^ to_int32(right)) as f64
}

pub fn shift_left(left: f64, right: f64) -> f64 {
    to_int32(left).wrapping_shl(to_uint32(right) & 31) as f64
}

pub fn shift_right(left: f64, right: f64) -> f64 {
    to_int32(left).wrapping_shr(to_uint32(right) & 31) as f64
}

pub fn shift_right_unsigned(left: f64, right: f64) -> f64 {
    to_uint32(left).wrapping_shr(to_uint32(right) & 31) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Link {
        next: Option<Gc<Link>>,
    }

    impl Trace for Link {
        fn trace(&self, tracer: &mut Tracer<'_>) {
            if let Some(next) = &self.next {
                tracer.edge(next);
            }
        }
    }

    impl ClearEdges for Link {
        fn clear_edges(&mut self) {
            self.next = None;
        }
    }

    #[test]
    fn formats_javascript_special_numbers() {
        assert_eq!(format_number(f64::NAN), "NaN");
        assert_eq!(format_number(f64::INFINITY), "Infinity");
        assert_eq!(format_number(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(format_number(-0.0), "0");
        assert_eq!(format_number(1e21), "1e+21");
        assert_eq!(format_number(1e-7), "1e-7");
        assert_eq!(format_number(1e-6), "0.000001");
        assert_eq!(format_number(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(display_number(-0.0), "-0");
    }

    #[test]
    fn char_at_uses_javascript_utf16_indexes() {
        let value = string("Aé🎉Z");
        assert_eq!(string_char_at(&value, f64::NAN).as_ref(), "A");
        assert_eq!(string_char_at(&value, 1.9).as_ref(), "é");
        assert_eq!(string_char_at(&value, 2.0).as_ref(), "�");
        assert_eq!(string_char_at(&value, 3.0).as_ref(), "�");
        assert_eq!(string_char_at(&value, 4.0).as_ref(), "Z");
        assert_eq!(string_char_at(&value, -1.0).as_ref(), "");
        assert_eq!(string_char_at(&value, f64::INFINITY).as_ref(), "");
    }

    #[test]
    fn string_case_conversion_handles_ascii() {
        let value = string("ScriptC 42");
        assert_eq!(string_to_lower_case(&value).as_ref(), "scriptc 42");
        assert_eq!(string_to_upper_case(&value).as_ref(), "SCRIPTC 42");
        assert!(string_includes(&value, &string("iptC"), 0.0));
        assert!(!string_includes(&value, &string("iptc"), 0.0));
    }

    #[test]
    fn scalar_json_stringification_escapes_strings_and_normalizes_non_finite_numbers() {
        assert_eq!(json_stringify(&f64::NAN).as_ref(), "null");
        assert_eq!(json_stringify(&f64::INFINITY).as_ref(), "null");
        assert_eq!(json_stringify(&-0.0).as_ref(), "0");
        assert_eq!(json_stringify(&true).as_ref(), "true");
        assert_eq!(
            json_stringify(&string("quote \" slash \\\n\t\u{0007}")).as_ref(),
            "\"quote \\\" slash \\\\\\n\\t\\u0007\""
        );
        assert_eq!(json_stringify(&string("héllo 😀")).as_ref(), "\"héllo 😀\"");
    }

    #[test]
    fn bitwise_conversions_follow_ecmascript_width() {
        assert_eq!(bit_not(0.0), -1.0);
        assert_eq!(shift_right_unsigned(-1.0, 1.0), 2_147_483_647.0);
    }

    #[test]
    fn same_value_distinguishes_signed_zero_and_matches_nan() {
        assert!(number_same_value(f64::NAN, f64::NAN));
        assert!(!number_same_value(0.0, -0.0));
        assert!(number_same_value(-0.0, -0.0));
    }

    #[test]
    fn arrays_preserve_aliasing_and_release_acyclic_values() {
        let baseline = live_heap_objects();
        {
            let array = array_new(vec![1.0, 2.0]);
            let alias = array.clone();
            array_set(&alias, 1.0, 9.0);
            assert_eq!(array_get(&array, 1.0), 9.0);
            assert!(array_ptr_eq(&array, &alias));
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn captured_cells_share_mutations_and_trace_heap_values() {
        let baseline = live_heap_objects();
        {
            let number = cell_new(1.0);
            let alias = number.clone();
            cell_set(&alias, 9.0);
            assert_eq!(cell_get(&number), 9.0);

            let array = array_new(vec![2.0]);
            let captured = cell_new(array.clone());
            drop(array);
            assert_eq!(array_get(&cell_get(&captured), 0.0), 2.0);
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn tdz_reads_unwind_as_typed_catchable_reference_errors() {
        let cell = cell_empty::<JsString>();
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            cell_get_tdz(&cell, "answer")
        }))
        .expect_err("an empty TDZ cell must unwind");
        let caught = caught_from_panic(payload);
        assert!(caught_is_error(&caught));
        assert_eq!(caught_error_name(&caught).as_ref(), "ReferenceError");
        assert_eq!(
            caught_error_message(&caught).as_ref(),
            "Cannot access 'answer' before initialization"
        );

        cell_set(&cell, string("ready"));
        assert_eq!(cell_get_tdz(&cell, "answer").as_ref(), "ready");
    }

    #[test]
    fn catch_conversion_rethrows_non_javascript_panics() {
        let payload = std::panic::catch_unwind(|| {
            std::panic::resume_unwind(Box::new("internal bug".to_owned()))
        })
        .expect_err("the synthetic internal panic must unwind");
        let propagated =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| caught_from_panic(payload)));
        assert!(propagated.is_err());
    }

    #[test]
    fn collector_breaks_self_and_mutual_cycles_without_unsafe() {
        let baseline = live_heap_objects();

        let self_cycle = Gc::new(Link { next: None });
        self_cycle.with_mut(|link| link.next = Some(self_cycle.clone()));
        drop(self_cycle);

        let left = Gc::new(Link { next: None });
        let right = Gc::new(Link { next: None });
        left.with_mut(|link| link.next = Some(right.clone()));
        right.with_mut(|link| link.next = Some(left.clone()));
        drop(left);
        drop(right);

        assert_eq!(live_heap_objects(), baseline + 3);
        assert_eq!(collect_cycles(), 3);
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn collector_keeps_a_cycle_with_an_outside_owner() {
        let baseline = live_heap_objects();
        let rooted = Gc::new(Link { next: None });
        rooted.with_mut(|link| link.next = Some(rooted.clone()));

        let released_alias = rooted.clone();
        drop(released_alias);
        assert_eq!(collect_cycles(), 0);
        assert_eq!(live_heap_objects(), baseline + 1);

        drop(rooted);
        assert_eq!(collect_cycles(), 1);
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promises_queue_reactions_and_settle_only_once() {
        let baseline = live_heap_objects();
        let promise = promise_new::<f64>();
        let events = Rc::new(RefCell::new(Vec::new()));

        let pending_events = events.clone();
        promise_then(
            &promise,
            Box::new(move |outcome| pending_events.borrow_mut().push(promise_unwrap(outcome))),
        );
        assert!(promise_fulfill(&promise, 7.0));
        assert!(!promise_fulfill(&promise, 9.0));
        assert!(events.borrow().is_empty());

        let settled_events = events.clone();
        promise_then(
            &promise,
            Box::new(move |outcome| settled_events.borrow_mut().push(promise_unwrap(outcome))),
        );
        run_event_loop();
        assert_eq!(events.borrow().as_slice(), &[7.0, 7.0]);

        let rejected = promise_new::<f64>();
        let rejected_events = events.clone();
        promise_then(
            &rejected,
            Box::new(move |outcome| match outcome {
                Ok(_) => panic!("scriptc: rejected promise fulfilled"),
                Err(reason) => rejected_events.borrow_mut().push(
                    if caught_error_name(&reason).as_ref() == "TypeError" {
                        -1.0
                    } else {
                        -2.0
                    },
                ),
            }),
        );
        promise_run_segment(&rejected, || throw_type_error("async failure".to_owned()));
        run_event_loop();
        assert_eq!(events.borrow().as_slice(), &[7.0, 7.0, -1.0]);

        drop(promise);
        drop(rejected);
        assert_eq!(live_heap_objects(), baseline);
    }
}
