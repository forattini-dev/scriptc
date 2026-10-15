fn bun_write_result(promise: &JsPromise<f64>) -> Result<f64, Caught> {
    let observed = Rc::new(RefCell::new(None));
    let output = observed.clone();
    promise_then(
        promise,
        Box::new(move |result| *output.borrow_mut() = Some(result)),
    );
    run_event_loop();
    let result = observed
        .borrow_mut()
        .take()
        .expect("write settled on its loop");
    result
}

#[test]
fn bun_write_utf8_bytes_truncation_and_recursive_parents() {
    let root = std::env::temp_dir().join(format!("scriptc-bun-write-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let file = root.join("nested/text");
    let path = string(file.to_str().unwrap());
    let promise = bun_write_text(&path, &string("\u{feff}ação🚀"));
    assert_eq!(
        bun_write_result(&promise)
            .unwrap_or_else(|reason| panic!("{}", caught_error_message(&reason))),
        13.0
    );
    assert_eq!(std::fs::read(&file).unwrap(), "\u{feff}ação🚀".as_bytes());
    let bytes = bytes_from_elements(vec![0_u8, 255, 97]);
    let promise = bun_write_bytes(&path, &bytes);
    bytes_set(&bytes, 0.0, 99.0);
    assert_eq!(
        bun_write_result(&promise)
            .unwrap_or_else(|reason| panic!("{}", caught_error_message(&reason))),
        3.0
    );
    assert_eq!(std::fs::read(&file).unwrap(), [0, 255, 97]);
    assert_eq!(
        bun_write_result(&bun_write_text(&path, &string("")))
            .unwrap_or_else(|reason| panic!("{}", caught_error_message(&reason))),
        0.0
    );
    assert_eq!(std::fs::metadata(&file).unwrap().len(), 0);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn bun_write_platform_and_utf16_size_control_promise_settlement() {
    let root = std::env::temp_dir().join(format!("scriptc-bun-write-order-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = string(root.join("text").to_str().unwrap());
    for (text, immediate) in [
        ("".to_owned(), true),
        ("é".repeat(BUN_WRITE_FAST_LIMIT - 1), !cfg!(windows)),
        ("a".repeat(BUN_WRITE_FAST_LIMIT), false),
    ] {
        let promise = bun_write_text(&path, &string(&text));
        assert_eq!(
            promise.with(|data| matches!(data.state, PromiseState::Fulfilled(_))),
            immediate
        );
        assert_eq!(
            bun_write_result(&promise)
                .unwrap_or_else(|reason| panic!("{}", caught_error_message(&reason))),
            text.len() as f64
        );
    }
    let missing = string(root.join("missing/text").to_str().unwrap());
    let promise = bun_write_text(&missing, &string("x"));
    assert!(promise.with(|data| matches!(data.state, PromiseState::Pending(_))));
    assert_eq!(
        bun_write_result(&promise)
            .unwrap_or_else(|reason| panic!("{}", caught_error_message(&reason))),
        1.0
    );
    assert!(!bun_files_pending());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn bun_write_nul_is_synchronous_but_io_errors_reject() {
    let result = std::panic::catch_unwind(|| bun_write_text(&string("a\0b"), &string("x")));
    let reason = caught_from_panic(result.err().expect("NUL must throw"));
    assert!(caught_is_error_class(&reason, "TypeError"));
    assert_eq!(
        caught_error_code(&reason),
        Some(string("ERR_INVALID_ARG_VALUE"))
    );
    for text in ["", "x"] {
        let reason = bun_write_result(&bun_write_text(&string(""), &string(text))).unwrap_err();
        assert_eq!(caught_error_code(&reason), Some(string("ENOENT")));
        assert_eq!(
            caught_error_message(&reason),
            string(&format!(
                "ENOENT: no such file or directory, {}",
                if text.is_empty() {
                    "truncate"
                } else if cfg!(windows) {
                    "mkdir"
                } else {
                    "open"
                }
            ))
        );
    }
}

#[test]
fn bun_write_workers_keep_promises_on_the_requesting_thread() {
    let threads: Vec<_> = (0..4)
        .map(|_| {
            std::thread::spawn(|| {
                let reason =
                    bun_write_result(&bun_write_text(&string(""), &string("x"))).unwrap_err();
                assert_eq!(caught_error_code(&reason), Some(string("ENOENT")));
                assert!(!bun_files_pending());
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
}
