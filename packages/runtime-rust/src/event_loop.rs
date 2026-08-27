/// Final safe point for generated executables.
///
/// The optional audit is test-only instrumentation: production binaries pay
/// only the final cycle pass, while differential tests can prove that every
/// traced array/record object was released.
pub fn finish() {
    process_signals_finish();
    stdin_finish();
    fs_renames_finish();
    children_finish();
    child_streams_finish();
    net_finish();
    dgram_finish();
    tls_ca_finish();
    live_dyn_refs_clear();
    PROCESS_ARGV.with(|slot| *slot.borrow_mut() = None);
    template_strings_clear();
    TIMER_TASKS.with(|tasks| tasks.borrow_mut().clear());
    IMMEDIATE_TASKS.with(|tasks| tasks.borrow_mut().clear());
    MICROTASKS.with(|tasks| tasks.borrow_mut().clear());
    NEXT_TICKS.with(|tasks| tasks.borrow_mut().clear());
    PROMISE_CHECKS.with(|checks| checks.borrow_mut().clear());
    UNHANDLED_REJECTION_HANDLER.with(|handler| *handler.borrow_mut() = None);
    REJECTION_HANDLED_HANDLER.with(|handler| *handler.borrow_mut() = None);
    ENTRY_PROMISE_OUTCOME.with(|outcome| *outcome.borrow_mut() = None);
    promises_finish();
    collect_cycles();
    if std::env::var_os("SCRIPTC_RUST_HEAP_AUDIT").is_some() {
        let live = live_heap_objects();
        assert_eq!(live, 0, "scriptc: {live} Rust heap object(s) still live");
    }
}

pub fn had_unhandled_rejection() -> bool {
    UNHANDLED_REJECTION.with(Cell::get)
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
    let delay_ms = if delay_ms.is_finite() && delay_ms >= 1.0 && delay_ms <= f64::from(i32::MAX) {
        delay_ms.trunc() as u64
    } else {
        1
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
    let rename_count = FS_RENAME_CALLBACKS.with(|callbacks| callbacks.borrow().len());
    let mut resources = Vec::with_capacity(timer_count + immediate_count + rename_count);
    resources.extend((0..timer_count).map(|_| string("Timeout")));
    resources.extend((0..immediate_count).map(|_| string("Immediate")));
    resources.extend((0..rename_count).map(|_| string("FSReqCallback")));
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
                identity: Rc::new(()),
                name: "RangeError".to_owned(),
                message: format!(
                    "The property 'prevValue.{name}' is invalid. Received {}",
                    format_number(value)
                ),
                code: Some("ERR_INVALID_ARG_VALUE".to_owned()),
                dom: None,
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
    let mut first_checkpoint = true;
    loop {
        EVENT_TURN.with(|current| current.set(turn));
        let skip_ticks = std::mem::replace(&mut first_checkpoint, false);
        if !skip_ticks {
            let next_tick = NEXT_TICKS.with(|tasks| tasks.borrow_mut().pop_front());
            if let Some(next_tick) = next_tick {
                EVENT_PHASE.with(|phase| phase.set(4));
                next_tick();
                continue;
            }
        }
        let mut microtask = MICROTASKS.with(|tasks| tasks.borrow_mut().pop_front());
        if microtask.is_some() {
            while let Some(callback) = microtask {
                EVENT_PHASE.with(|phase| phase.set(3));
                callback();
                microtask = MICROTASKS.with(|tasks| tasks.borrow_mut().pop_front());
            }
            if promise_entry_failed() {
                break;
            }
            continue;
        }
        if skip_ticks && NEXT_TICKS.with(|tasks| !tasks.borrow().is_empty()) {
            continue;
        }

        let mut promise_check = PROMISE_CHECKS.with(|checks| checks.borrow_mut().pop_front());
        if promise_check.is_some() {
            while let Some(check) = promise_check {
                check();
                promise_check = PROMISE_CHECKS.with(|checks| checks.borrow_mut().pop_front());
            }
            if had_unhandled_rejection() {
                break;
            }
            continue;
        }

        if fs_renames_dispatch_one() {
            continue;
        }
        if process_signals_dispatch_one() {
            continue;
        }
        if stdin_dispatch_one() {
            continue;
        }
        if net_dispatch_one() {
            continue;
        }
        if dgram_dispatch_one() {
            continue;
        }
        if child_streams_dispatch_one() {
            continue;
        }
        let has_referenced_work = TIMER_TASKS
            .with(|tasks| tasks.borrow().iter().any(|task| task.referenced))
            || IMMEDIATE_TASKS.with(|tasks| tasks.borrow().iter().any(|task| task.referenced))
            || fs_renames_pending()
            || stdin_pending()
            || children_referenced_pending()
            || children_failed_pending()
            || child_streams_pending()
            || net_pending()
            || dgram_pending();
        if !has_referenced_work {
            break;
        }
        if children_dispatch_one() {
            continue;
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
        if fs_renames_pending() {
            let wait =
                next_due.and_then(|due| due.checked_duration_since(std::time::Instant::now()));
            fs_renames_wait(wait);
            continue;
        }
        if stdin_pending() {
            let wait =
                next_due.and_then(|due| due.checked_duration_since(std::time::Instant::now()));
            stdin_wait(wait);
            continue;
        }
        if net_pending() {
            let wait =
                next_due.and_then(|due| due.checked_duration_since(std::time::Instant::now()));
            net_wait(wait);
            continue;
        }
        if dgram_pending() {
            let wait =
                next_due.and_then(|due| due.checked_duration_since(std::time::Instant::now()));
            dgram_wait(wait);
            continue;
        }
        if children_referenced_pending() || child_streams_pending() {
            let wait =
                next_due.and_then(|due| due.checked_duration_since(std::time::Instant::now()));
            children_wait(wait);
            continue;
        }
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
