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
