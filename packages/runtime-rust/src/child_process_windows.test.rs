#[cfg(windows)]
#[test]
fn windows_child_kill_terminates_owned_processes_and_reports_the_requested_signal() {
    struct Cleanup(JsChild);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.with_mut(|child| {
                if let Some(process) = child.process.as_mut() {
                    let _ = process.kill();
                    let _ = process.wait();
                }
            });
            ASYNC_CHILDREN
                .with(|children| children.borrow_mut().retain(|child| !child.ptr_eq(&self.0)));
        }
    }
    let executable = std::env::var("SCRIPTC_NODE_ORACLE").unwrap_or_else(|_| "node".to_owned());
    for numeric in [false, true] {
        let _deadline = loop_deadline(3_000.0);
        let child = child_spawn_options(
            &string(&executable),
            &array_new(vec![string("-e"), string("setTimeout(() => {}, 30000)")]),
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            false,
            false,
            &array_new(Vec::new()),
            &string(""),
        );
        let _cleanup = Cleanup(child.clone());
        assert!(child_pid(&child).is_some());
        assert!(child_kill_num(&child, 0.0));
        assert!(
            child.with_mut(|child| matches!(child.process.as_mut().unwrap().try_wait(), Ok(None)))
        );
        let outcome = Rc::new(RefCell::new(None));
        let observed = outcome.clone();
        child_on_exit(
            &child,
            Rc::new(move |code, signal| *observed.borrow_mut() = Some((code, signal))),
            no_trace(),
        );
        assert!(if numeric {
            child_kill_num(&child, 9.0)
        } else {
            child_kill(&child, &string("SIGTERM"))
        });
        run_event_loop();
        let expected = if numeric { "SIGKILL" } else { "SIGTERM" };
        assert_eq!(*outcome.borrow(), Some((None, Some(string(expected)))));
        assert_eq!(child_exit_code(&child), None);
        assert!(child_killed(&child));
        assert!(!child_kill(&child, &string("SIGTERM")));
    }
}
