#[derive(Clone, Copy)]
struct NetworkLoopHooks {
    pending: fn() -> bool,
    dispatch: fn() -> bool,
    wait: fn(Option<std::time::Duration>),
    finish: fn(),
}

thread_local! {
    static NETWORK_LOOP_HOOKS: Cell<Option<NetworkLoopHooks>> = const { Cell::new(None) };
}

fn net_register_loop_hooks() {
    NETWORK_LOOP_HOOKS.with(|slot| slot.set(Some(NetworkLoopHooks {
        pending: net_pending,
        dispatch: net_dispatch_one,
        wait: net_wait,
        finish: net_finish,
    })));
}

fn loop_net_pending() -> bool {
    NETWORK_LOOP_HOOKS.with(Cell::get).is_some_and(|hooks| (hooks.pending)())
}

fn loop_net_dispatch_one() -> bool {
    NETWORK_LOOP_HOOKS.with(Cell::get).is_some_and(|hooks| (hooks.dispatch)())
}

fn loop_net_wait(timeout: Option<std::time::Duration>) {
    if let Some(hooks) = NETWORK_LOOP_HOOKS.with(Cell::get) {
        (hooks.wait)(timeout);
    }
}

fn loop_net_finish() {
    if let Some(hooks) = NETWORK_LOOP_HOOKS.with(Cell::take) {
        (hooks.finish)();
    }
}

#[cfg(test)]
mod network_loop_tests {
    use super::*;

    #[test]
    fn network_registration_serves_callbacks_and_resets_between_sessions() {
        for _ in 0..2 {
            init();
            assert!(NETWORK_LOOP_HOOKS.with(Cell::get).is_none());
            let server = net_server_new();
            let listened = Rc::new(Cell::new(false));
            let observed = listened.clone();
            let closing = server.clone();
            net_server_on_listening(
                &server,
                Rc::new(move || {
                    observed.set(true);
                    net_server_close(&closing);
                }),
                Rc::new(|_| {}),
                true,
            );
            net_server_listen(&server, 0.0);
            run_event_loop();
            assert!(listened.get());
            assert!(!loop_net_pending());
            drop(server);
            finish();
            assert!(NETWORK_LOOP_HOOKS.with(Cell::get).is_none());
            assert_eq!(live_heap_objects(), 0);
        }
    }
}

fn net_dispatch_one() -> bool {
    if let Some(task) = NET_TASKS.with(|tasks| tasks.borrow_mut().pop_front()) {
        net_dispatch_task(task);
        return true;
    }
    http_tls_dispatch_one()
        || net_accept_one()
        || net_socket_connect_one()
        || tls_socket_dispatch_one()
        || net_socket_flush_one()
        || net_socket_read_one()
}

fn net_finish() {
    http_tls_finish();
    NET_TASKS.with(|tasks| tasks.borrow_mut().clear());
    let servers = NET_SERVERS.with(|servers| std::mem::take(&mut *servers.borrow_mut()));
    for server in servers {
        server.with_mut(ClearEdges::clear_edges);
    }
    let sockets = NET_SOCKETS.with(|sockets| std::mem::take(&mut *sockets.borrow_mut()));
    for socket in sockets {
        socket.with_mut(ClearEdges::clear_edges);
    }
}
