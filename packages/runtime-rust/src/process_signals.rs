struct ProcessSignalListener {
    id: u64,
    identity: usize,
    once: bool,
    callback: Rc<dyn Fn()>,
}

struct ProcessSignalRegistration {
    signal: i32,
    flag: Arc<std::sync::atomic::AtomicBool>,
    hook: signal_hook::SigId,
    listeners: Vec<ProcessSignalListener>,
}

type ProcessSignalSnapshot = Vec<(u64, bool, Rc<dyn Fn()>)>;

thread_local! {
    static PROCESS_SIGNAL_REGISTRATIONS: RefCell<Vec<ProcessSignalRegistration>> = const { RefCell::new(Vec::new()) };
    static NEXT_PROCESS_SIGNAL_LISTENER_ID: Cell<u64> = const { Cell::new(1) };
}

pub fn process_signal_on(signal: f64, identity: usize, callback: Rc<dyn Fn()>, once: bool) {
    let signal = signal as i32;
    PROCESS_SIGNAL_REGISTRATIONS.with(|registrations| {
        let mut registrations = registrations.borrow_mut();
        let index = registrations.iter().position(|entry| entry.signal == signal);
        let index = match index {
            Some(index) => index,
            None => {
                let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let hook = signal_hook::flag::register(signal, Arc::clone(&flag))
                    .unwrap_or_else(|error| throw_error(format!("failed to register signal: {error}")));
                registrations.push(ProcessSignalRegistration {
                    signal,
                    flag,
                    hook,
                    listeners: Vec::new(),
                });
                registrations.len() - 1
            }
        };
        let id = NEXT_PROCESS_SIGNAL_LISTENER_ID.with(|next| {
            let id = next.get();
            next.set(id.checked_add(1).expect("scriptc: exhausted signal listener ids"));
            id
        });
        registrations[index].listeners.push(ProcessSignalListener {
            id,
            identity,
            once,
            callback,
        });
    });
}

pub fn process_signal_off(signal: f64, identity: usize) {
    let signal = signal as i32;
    PROCESS_SIGNAL_REGISTRATIONS.with(|registrations| {
        let mut registrations = registrations.borrow_mut();
        let Some(registration_index) = registrations.iter().position(|entry| entry.signal == signal)
        else {
            return;
        };
        let Some(listener_index) = registrations[registration_index]
            .listeners
            .iter()
            .position(|listener| listener.identity == identity)
        else {
            return;
        };
        registrations[registration_index].listeners.remove(listener_index);
        if registrations[registration_index].listeners.is_empty() {
            let registration = registrations.remove(registration_index);
            signal_hook::low_level::unregister(registration.hook);
        }
    });
}

fn process_signals_dispatch_one() -> bool {
    use std::sync::atomic::Ordering;

    let delivery = PROCESS_SIGNAL_REGISTRATIONS.with(|registrations| {
        let mut registrations = registrations.borrow_mut();
        let index = registrations
            .iter()
            .position(|entry| entry.flag.swap(false, Ordering::SeqCst))?;
        let snapshot: ProcessSignalSnapshot = registrations[index]
            .listeners
            .iter()
            .map(|listener| (listener.id, listener.once, Rc::clone(&listener.callback)))
            .collect();
        let once_ids: HashSet<u64> = snapshot
            .iter()
            .filter_map(|(id, once, _)| once.then_some(*id))
            .collect();
        registrations[index]
            .listeners
            .retain(|listener| !once_ids.contains(&listener.id));
        if registrations[index].listeners.is_empty() {
            let registration = registrations.remove(index);
            signal_hook::low_level::unregister(registration.hook);
        }
        Some(snapshot)
    });
    let Some(delivery) = delivery else {
        return false;
    };
    for (_, _, callback) in delivery {
        callback();
    }
    true
}

fn process_signals_finish() {
    PROCESS_SIGNAL_REGISTRATIONS.with(|registrations| {
        for registration in registrations.borrow_mut().drain(..) {
            signal_hook::low_level::unregister(registration.hook);
        }
    });
}
