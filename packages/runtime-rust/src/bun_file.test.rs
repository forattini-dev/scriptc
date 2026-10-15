#[test]
fn bun_file_text_decodes_utf8_removing_exactly_one_bom() {
    for (bytes, expected) in [
        (&b""[..], ""),
        (&b"\xef\xbb\xbfa"[..], "a"),
        (&b"\xef\xbb\xbf\xef\xbb\xbfa"[..], "\u{feff}a"),
        (&b"\xf0\x28\x8c\x28"[..], "\u{fffd}(\u{fffd}("),
        (&b"a\0b"[..], "a\0b"),
        (&b"a\xc3\xa7\xf0\x9f\x9a\x80"[..], "aç🚀"),
    ] {
        assert_eq!(bun_file_decode(bytes).to_utf8_lossy(), expected);
    }
}

#[test]
fn bun_file_constructor_rejects_nul_before_a_promise_exists() {
    let result = std::panic::catch_unwind(|| bun_file_path(&string("a\0b")));
    let reason = caught_from_panic(result.unwrap_err());
    assert!(caught_is_error_class(&reason, "TypeError"));
    assert_eq!(
        caught_error_code(&reason),
        Some(string("ERR_INVALID_ARG_VALUE"))
    );
    assert_eq!(
        caught_error_message(&reason),
        string(
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received \"a\\u0000b\""
        )
    );
}

#[test]
fn bun_file_async_reads_are_pending_and_settle_on_the_owning_loop() {
    let root = std::env::temp_dir().join(format!("scriptc-bun-file-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("text");
    std::fs::write(&path, "\u{feff}ação").unwrap();
    let seen = Rc::new(RefCell::new(Vec::new()));
    for (input, expected) in [
        (path.to_str().unwrap(), "ação"),
        (
            root.to_str().unwrap(),
            "Directories cannot be read like files",
        ),
        ("", "ENOENT: no such file or directory, open"),
    ] {
        let result = bun_file_text(&string(input));
        let seen = seen.clone();
        promise_then(
            &result,
            Box::new(move |outcome| {
                let text = match outcome {
                    Ok(value) => value,
                    Err(reason) => caught_error_message(&reason),
                };
                assert_eq!(text, string(expected));
                seen.borrow_mut().push(text);
            }),
        );
    }
    assert!(seen.borrow().is_empty());
    run_event_loop();
    assert_eq!(seen.borrow().len(), 3);
    assert!(!bun_files_pending());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn bun_file_errors_keep_the_supported_error_name_message_and_code() {
    let error = bun_file_error(
        &string("missing"),
        std::io::Error::from(std::io::ErrorKind::NotFound),
    );
    assert_eq!(error_name(&error), string("Error"));
    assert_eq!(
        error_message(&error),
        string("ENOENT: no such file or directory, open 'missing'")
    );
    assert_eq!(error_code(&error), Some(string("ENOENT")));
}

#[test]
fn bun_file_workers_deliver_only_to_the_requesting_event_loop() {
    let threads: Vec<_> = (0..4)
        .map(|_| {
            std::thread::spawn(|| {
                let observed = Rc::new(Cell::new(false));
                let output = observed.clone();
                let promise = bun_file_text(&string(""));
                promise_then(
                    &promise,
                    Box::new(move |outcome| {
                        let reason = outcome.expect_err("empty paths must reject");
                        assert_eq!(caught_error_code(&reason), Some(string("ENOENT")));
                        output.set(true);
                    }),
                );
                run_event_loop();
                assert!(observed.get());
                assert!(!bun_files_pending());
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
}
