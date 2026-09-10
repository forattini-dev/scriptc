// Drive the parser without attaching a real stdin worker to the test process.
fn readline_test_interface() -> f64 {
    readline_finish();
    READLINE_STATE.with(|state| state.borrow_mut().interfaces.push(ReadlineInterface {
        id: 1, closed: false, dead: false, output: false, question: None, next_line: None,
        close_listeners: Vec::new(), buffer: Vec::new(), iterating: false,
        lines: VecDeque::new(),
    }));
    1.0
}

#[test]
fn readline_iterator_drains_received_events_after_close() {
    let id = readline_test_interface();
    let events = Rc::new(RefCell::new(Vec::new()));
    let output = events.clone();
    readline_next_line(id, Box::new(move |line| output.borrow_mut().push(line)));
    readline_stdin_data(b"one\ntwo\nthree\n");
    assert_eq!(events.borrow().len(), 1);
    readline_close(id);
    readline_stdin_data(b"ignored\n");
    for _ in 0..3 {
        let output = events.clone();
        readline_next_line(id, Box::new(move |line| output.borrow_mut().push(line)));
    }
    assert_eq!(*events.borrow(), vec![Some(string("one")), Some(string("two")), Some(string("three")), None]);
    readline_finish();
    assert_eq!(Rc::strong_count(&events), 1);
}

#[test]
fn readline_close_listeners_precede_a_pending_read_completion() {
    let id = readline_test_interface();
    let events = Rc::new(RefCell::new(Vec::new()));
    let output = events.clone();
    readline_next_line(id, Box::new(move |line| {
        assert!(line.is_none()); output.borrow_mut().push("done");
    }));
    let output = events.clone();
    readline_on_close(id, Box::new(move || output.borrow_mut().push("close")));
    readline_close(id);
    readline_close(id);
    assert_eq!(*events.borrow(), vec!["close", "done"]);
    readline_finish();
    assert_eq!(Rc::strong_count(&events), 1);
}

#[test]
fn readline_eof_tail_bypasses_a_pending_question() {
    let id = readline_test_interface();
    let answered = Rc::new(Cell::new(false));
    let flag = answered.clone();
    READLINE_STATE.with(|state| {
        state.borrow_mut().interfaces[0].question = Some(Box::new(move |_| flag.set(true)));
    });
    let events = Rc::new(RefCell::new(Vec::new()));
    let output = events.clone();
    readline_next_line(id, Box::new(move |line| output.borrow_mut().push(line)));
    readline_stdin_data(b"tail");
    readline_stdin_end();
    assert!(!answered.get());
    assert_eq!(*events.borrow(), vec![Some(string("tail"))]);
    assert_eq!(Rc::strong_count(&answered), 1);
    readline_finish();
    assert_eq!(Rc::strong_count(&events), 1);
}

#[test]
fn readline_only_queues_events_after_iteration_has_started() {
    let id = readline_test_interface();
    readline_stdin_data(b"unobserved\npar");
    let events = Rc::new(RefCell::new(Vec::new()));
    let output = events.clone();
    readline_next_line(id, Box::new(move |line| output.borrow_mut().push(line)));
    assert!(events.borrow().is_empty());
    readline_stdin_data(b"tial\n");
    assert_eq!(*events.borrow(), vec![Some(string("partial"))]);
    readline_finish();
    assert_eq!(Rc::strong_count(&events), 1);
}
