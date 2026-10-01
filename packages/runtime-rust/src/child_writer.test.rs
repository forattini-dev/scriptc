fn controlled_child_writer() -> (
    JsChildWriter,
    std::sync::mpsc::Sender<ChildWriterEvent>,
    std::sync::mpsc::Receiver<ChildWriterCommand>,
) {
    let (sender, commands) = std::sync::mpsc::channel();
    let (events, receiver) = std::sync::mpsc::channel();
    let writer = Gc::new(ChildWriterData {
        sender: Some(sender),
        receiver: Some(receiver),
        queued: 0,
        #[cfg(unix)]
        sync_stdin: None,
        needs_drain: false,
        writable: true,
        finished: false,
        drain_listeners: Vec::new(),
        finish_listeners: Vec::new(),
        error_listeners: Vec::new(),
    });
    ASYNC_CHILD_WRITERS.with(|writers| writers.borrow_mut().push(writer.clone()));
    (writer, events, commands)
}

#[test]
fn child_writer_drain_waits_for_all_queued_bytes() {
    std::thread::spawn(|| {
        let (writer, events, _commands) = controlled_child_writer();
        let calls = Rc::new(Cell::new(0));
        let seen = calls.clone();
        child_writer_on_drain(
            &writer,
            Rc::new(move || seen.set(seen.get() + 1)),
            Rc::new(|_| {}),
            false,
        );
        assert!(!child_writer_write(
            &writer,
            vec![0; CHILD_WRITER_HIGH_WATER_MARK]
        ));
        assert!(!child_writer_write(&writer, vec![0; 4096]));
        events
            .send(ChildWriterEvent::Wrote(CHILD_WRITER_HIGH_WATER_MARK))
            .unwrap();
        assert!(child_writers_dispatch_one());
        assert_eq!(calls.get(), 0, "falling below the watermark is not a drain");
        events.send(ChildWriterEvent::Wrote(4096)).unwrap();
        assert!(child_writers_dispatch_one());
        assert_eq!(calls.get(), 1);
        child_writer_destroy(&writer);
    })
    .join()
    .unwrap();
}

#[test]
fn child_writer_end_suppresses_drain_but_finishes_once() {
    std::thread::spawn(|| {
        let (writer, events, _commands) = controlled_child_writer();
        let drains = Rc::new(Cell::new(0));
        let finishes = Rc::new(Cell::new(0));
        let seen = drains.clone();
        child_writer_on_drain(
            &writer,
            Rc::new(move || seen.set(seen.get() + 1)),
            Rc::new(|_| {}),
            false,
        );
        let seen = finishes.clone();
        child_writer_on_finish(
            &writer,
            Rc::new(move || seen.set(seen.get() + 1)),
            Rc::new(|_| {}),
            false,
        );
        assert!(!child_writer_write(
            &writer,
            vec![0; CHILD_WRITER_HIGH_WATER_MARK]
        ));
        child_writer_end(&writer);
        events
            .send(ChildWriterEvent::Wrote(CHILD_WRITER_HIGH_WATER_MARK))
            .unwrap();
        assert!(child_writers_dispatch_one());
        assert_eq!(drains.get(), 0, "ending writers do not emit drain");
        events.send(ChildWriterEvent::Finished).unwrap();
        assert!(child_writers_dispatch_one());
        assert_eq!(finishes.get(), 1);
        assert!(!child_writers_dispatch_one());
    })
    .join()
    .unwrap();
}

#[cfg(unix)]
#[test]
fn child_writer_partial_write_preserves_bytes_and_original_queue_length() {
    std::thread::spawn(|| {
        use std::io::Read;
        use std::os::fd::OwnedFd;
        let (stdin, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let _ =
            rustix::net::sockopt::set_socket_send_buffer_size(&stdin, CHILD_WRITER_HIGH_WATER_MARK);
        let (writer, events, commands) = controlled_child_writer();
        writer.with_mut(|writer| {
            writer.sync_stdin = Some(std::process::ChildStdin::from(OwnedFd::from(stdin)))
        });
        let data: Vec<u8> = (0..1024 * 1024).map(|index| (index % 251) as u8).collect();
        assert!(!child_writer_write(&writer, data.clone()));
        let ChildWriterCommand::Write { data: tail, length } = commands.try_recv().unwrap() else {
            panic!("expected a partial write");
        };
        assert_eq!(length, data.len());
        assert_eq!(writer.with(|writer| writer.queued), data.len());
        assert!(
            !writer
                .with(
                    |writer| rustix::fs::fcntl_getfl(writer.sync_stdin.as_ref().unwrap()).unwrap()
                )
                .contains(rustix::fs::OFlags::NONBLOCK),
            "the worker must retain blocking writes"
        );
        assert!(!tail.is_empty());
        assert!(tail.len() < data.len());
        let prefix_length = data.len() - tail.len();
        let mut prefix = vec![0; prefix_length];
        peer.read_exact(&mut prefix).unwrap();
        assert_eq!(prefix, data[..prefix_length]);
        assert_eq!(tail, data[prefix_length..]);

        // Even with socket capacity now free, a pending chunk owns the queue.
        assert!(!child_writer_write(&writer, vec![252; 4096]));
        let ChildWriterCommand::Write {
            data: next,
            length: next_length,
        } = commands.try_recv().unwrap()
        else {
            panic!("expected a queued write");
        };
        assert_eq!(next, vec![252; 4096]);
        assert_eq!(next_length, 4096);
        peer.set_nonblocking(true).unwrap();
        assert_eq!(
            peer.read(&mut [0]).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        events.send(ChildWriterEvent::Wrote(length)).unwrap();
        assert!(child_writers_dispatch_one());
        assert_eq!(writer.with(|writer| writer.queued), 4096);
        events.send(ChildWriterEvent::Wrote(4096)).unwrap();
        assert!(child_writers_dispatch_one());
        child_writer_destroy(&writer);
    })
    .join()
    .unwrap();
}

#[test]
fn child_writer_once_drain_listener_is_removed_before_reentrant_write() {
    std::thread::spawn(|| {
        let (writer, events, _commands) = controlled_child_writer();
        let persistent_calls = Rc::new(Cell::new(0));
        let once_calls = Rc::new(Cell::new(0));
        let seen = persistent_calls.clone();
        child_writer_on_drain(
            &writer,
            Rc::new(move || seen.set(seen.get() + 1)),
            Rc::new(|_| {}),
            false,
        );
        let seen = once_calls.clone();
        let next_writer = writer.clone();
        let traced_writer = writer.clone();
        child_writer_on_drain(
            &writer,
            Rc::new(move || {
                seen.set(seen.get() + 1);
                assert!(!child_writer_write(
                    &next_writer,
                    vec![0; CHILD_WRITER_HIGH_WATER_MARK]
                ));
            }),
            Rc::new(move |tracer| tracer.edge(&traced_writer)),
            true,
        );
        assert!(!child_writer_write(
            &writer,
            vec![0; CHILD_WRITER_HIGH_WATER_MARK]
        ));
        for _ in 0..2 {
            events
                .send(ChildWriterEvent::Wrote(CHILD_WRITER_HIGH_WATER_MARK))
                .unwrap();
            assert!(child_writers_dispatch_one());
        }
        assert_eq!(persistent_calls.get(), 2);
        assert_eq!(once_calls.get(), 1);
        assert_eq!(writer.with(|writer| writer.queued), 0);
        child_writer_destroy(&writer);
    })
    .join()
    .unwrap();
}

#[cfg(unix)]
#[test]
fn child_writer_sync_error_observes_listener_attached_after_write() {
    std::thread::spawn(|| {
        use std::os::fd::OwnedFd;
        let (stdin, peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let (writer, _events, _commands) = controlled_child_writer();
        writer.with_mut(|writer| {
            writer.sync_stdin = Some(std::process::ChildStdin::from(OwnedFd::from(stdin)))
        });
        drop(peer);
        assert!(!child_writer_write(&writer, vec![65]));
        assert!(!child_writer_writable(&writer));
        let errors = Rc::new(RefCell::new(Vec::new()));
        let seen = errors.clone();
        child_writer_on_error(
            &writer,
            Rc::new(move |error| seen.borrow_mut().push(error.code)),
            Rc::new(|_| {}),
            false,
        );
        assert!(
            errors.borrow().is_empty(),
            "write errors arrive on a later turn"
        );
        let next_tick = NEXT_TICKS
            .with(|ticks| ticks.borrow_mut().pop_front())
            .expect("queued error event");
        next_tick();
        assert_eq!(*errors.borrow(), vec![Some("EPIPE".to_owned())]);
    })
    .join()
    .unwrap();
}

#[cfg(unix)]
#[test]
fn child_writer_end_keeps_stdin_until_finish_dispatch() {
    std::thread::spawn(|| {
        use std::io::Read;
        use std::os::fd::OwnedFd;
        let (stdin, mut peer) = std::os::unix::net::UnixStream::pair().unwrap();
        let (writer, events, commands) = controlled_child_writer();
        writer.with_mut(|writer| {
            writer.sync_stdin = Some(std::process::ChildStdin::from(OwnedFd::from(stdin)))
        });
        peer.set_nonblocking(true).unwrap();
        child_writer_end(&writer);
        assert!(matches!(
            commands.try_recv().unwrap(),
            ChildWriterCommand::End
        ));
        assert_eq!(
            peer.read(&mut [0]).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        events.send(ChildWriterEvent::Finished).unwrap();
        assert!(child_writers_dispatch_one());
        assert_eq!(
            peer.read(&mut [0]).unwrap(),
            0,
            "finish closes the last descriptor"
        );
    })
    .join()
    .unwrap();
}
