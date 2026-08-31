fn dgram_pending() -> bool {
    DGRAM_SOCKETS.with(|sockets| {
        sockets.borrow().iter().any(|socket| {
            socket.with(|state| {
                state.pending_error.is_some()
                    || state.emit_listening
                    || state.emit_connect
                    || (state.closing && !state.close_emitted)
                    || !state.unrefed
            })
        })
    })
}

#[cfg(all(not(windows), not(target_os = "wasi")))]
fn dgram_poll(timeout: Option<std::time::Duration>) -> bool {
    let mut sockets = Vec::new();
    let mut unpollable = false;
    DGRAM_SOCKETS.with(|registered| {
        for socket in registered.borrow().iter() {
            socket.with(|state| {
                if state.pending_error.is_some()
                    || state.emit_listening
                    || state.emit_connect
                    || state.closing
                {
                    unpollable = true;
                }
                let Some(socket) = &state.socket else {
                    if !state.unrefed {
                        unpollable = true;
                    }
                    return;
                };
                match socket.try_clone() {
                    Ok(socket) => sockets.push(socket),
                    Err(_) => unpollable = true,
                }
            });
        }
    });
    if sockets.is_empty() {
        return false;
    }
    let timeout = if unpollable || net_pending() {
        let quantum = std::time::Duration::from_millis(1);
        Some(timeout.map_or(quantum, |timeout| timeout.min(quantum)))
    } else {
        timeout
    };
    let timeout = io_poll_timeout(timeout);
    let mut fds = sockets
        .iter()
        .map(|socket| rustix::event::PollFd::new(socket, rustix::event::PollFlags::IN))
        .collect::<Vec<_>>();
    rustix::event::poll(&mut fds, timeout.as_ref()).is_ok()
}

fn dgram_wait(timeout: Option<std::time::Duration>) {
    #[cfg(all(not(windows), not(target_os = "wasi")))]
    if dgram_poll(timeout) {
        return;
    }
    let interval = std::time::Duration::from_millis(1);
    let wait = timeout.map_or(interval, |timeout| timeout.min(interval));
    if !wait.is_zero() {
        std::thread::sleep(wait);
    }
}
