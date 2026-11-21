    #[test]
    fn uncaught_timer_exception_preserves_pending_work_and_timer_state() {
        init();
        let order = Rc::new(RefCell::new(Vec::new()));
        let first = order.clone();
        timer_set_timeout(Box::new(move || {
            first.borrow_mut().push("timer");
            throw_value(string("failure"));
        }), 0.0);
        let second = order.clone();
        timer_set_timeout(Box::new(move || second.borrow_mut().push("next")), 0.0);
        let handled = order.clone();
        run_event_loop_with_uncaught_handler(move |caught| {
            assert_eq!(caught_narrow::<JsString>(&caught), string("failure"));
            handled.borrow_mut().push("caught");
        });
        assert_eq!(*order.borrow(), ["timer", "caught", "next"]);
        finish();
    }

    #[test]
    fn first_event_loop_checkpoint_runs_module_microtasks_before_ticks() {
        init();
        let order = Rc::new(RefCell::new(Vec::new()));
        let tick_order = order.clone();
        process_next_tick(Box::new(move || tick_order.borrow_mut().push("tick")));
        let microtask_order = order.clone();
        timer_queue_microtask(Box::new(move || {
            microtask_order.borrow_mut().push("microtask");
            let nested_order = microtask_order.clone();
            process_next_tick(Box::new(move || nested_order.borrow_mut().push("nested tick")));
        }));

        run_event_loop();
        assert_eq!(*order.borrow(), ["microtask", "tick", "nested tick"]);
        finish();
    }

    #[test]
    fn first_commonjs_checkpoint_runs_ticks_before_microtasks() {
        init();
        let order = Rc::new(RefCell::new(Vec::new()));
        let tick_order = order.clone();
        process_next_tick(Box::new(move || tick_order.borrow_mut().push("tick")));
        let microtask_order = order.clone();
        timer_queue_microtask(Box::new(move || {
            microtask_order.borrow_mut().push("microtask");
            let nested_order = microtask_order.clone();
            process_next_tick(Box::new(move || nested_order.borrow_mut().push("nested tick")));
        }));

        run_event_loop_commonjs();
        assert_eq!(*order.borrow(), ["tick", "microtask", "nested tick"]);
        finish();
    }
