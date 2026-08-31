fn net_pending() -> bool {
    http_tls_pending()
        || NET_TASKS.with(|tasks| !tasks.borrow().is_empty())
        || NET_SERVERS.with(|servers| {
            servers
                .borrow()
                .iter()
                .any(|server| server.with(|server| server.listener.is_some() || server.closing))
        })
        || NET_SOCKETS.with(|sockets| {
            sockets
                .borrow()
                .iter()
                .any(|socket| socket.with(|socket| !socket.destroyed))
        })
}

#[cfg(all(not(windows), not(target_os = "wasi")))]
struct NetPollHandles {
    listeners: Vec<std::net::TcpListener>,
    streams: Vec<(std::net::TcpStream, rustix::event::PollFlags)>,
    unpollable: bool,
}

#[cfg(all(not(windows), not(target_os = "wasi")))]
fn net_poll_handles() -> NetPollHandles {
    let mut handles = NetPollHandles {
        listeners: Vec::new(),
        streams: Vec::new(),
        unpollable: http_tls_pending() || NET_TASKS.with(|tasks| !tasks.borrow().is_empty()),
    };
    NET_SERVERS.with(|servers| {
        for server in servers.borrow().iter() {
            server.with(|server| match &server.listener {
                Some(listener) => match listener.try_clone() {
                    Ok(listener) => handles.listeners.push(listener),
                    Err(_) => handles.unpollable = true,
                },
                None if server.closing => handles.unpollable = true,
                None => {}
            });
        }
    });
    NET_SOCKETS.with(|sockets| {
        for socket in sockets.borrow().iter() {
            socket.with(|socket| {
                if socket.destroyed {
                    return;
                }
                if socket.pending_connect.is_some()
                    || socket.connect_rx.is_some()
                    || socket.tls.is_some()
                {
                    handles.unpollable = true;
                }
                let Some(stream) = &socket.stream else {
                    return;
                };
                let mut events = rustix::event::PollFlags::empty();
                if socket.flowing || socket.end_requested {
                    events |= rustix::event::PollFlags::IN;
                }
                if !socket.write_queue.is_empty() {
                    events |= rustix::event::PollFlags::OUT;
                }
                if events.is_empty() {
                    handles.unpollable = true;
                    return;
                }
                match stream.try_clone() {
                    Ok(stream) => handles.streams.push((stream, events)),
                    Err(_) => handles.unpollable = true,
                }
            });
        }
    });
    handles
}

#[cfg(all(not(windows), not(target_os = "wasi")))]
fn net_poll(timeout: Option<std::time::Duration>) -> bool {
    let handles = net_poll_handles();
    if handles.listeners.is_empty() && handles.streams.is_empty() {
        return false;
    }
    let timeout = if handles.unpollable {
        let quantum = std::time::Duration::from_millis(1);
        Some(timeout.map_or(quantum, |timeout| timeout.min(quantum)))
    } else {
        timeout
    };
    let timeout = timeout.map(|timeout| rustix::event::Timespec {
        tv_sec: i64::try_from(timeout.as_secs()).unwrap_or(i64::MAX),
        tv_nsec: timeout.subsec_nanos().into(),
    });
    let mut fds = Vec::with_capacity(handles.listeners.len() + handles.streams.len());
    for listener in &handles.listeners {
        fds.push(rustix::event::PollFd::new(
            listener,
            rustix::event::PollFlags::IN,
        ));
    }
    for (stream, events) in &handles.streams {
        fds.push(rustix::event::PollFd::new(stream, *events));
    }
    rustix::event::poll(&mut fds, timeout.as_ref()).is_ok()
}

fn net_wait(timeout: Option<std::time::Duration>) {
    #[cfg(all(not(windows), not(target_os = "wasi")))]
    if net_poll(timeout) {
        return;
    }
    let polling_interval = std::time::Duration::from_millis(1);
    let wait = timeout.map_or(polling_interval, |timeout| timeout.min(polling_interval));
    if !wait.is_zero() {
        std::thread::sleep(wait);
    }
}
