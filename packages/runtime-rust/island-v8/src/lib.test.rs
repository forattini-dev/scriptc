use super::*;

fn setup_rejection_modules() {
    if !is_initialized() { init(); }
    set_module_resolver(Rc::new(|_, specifier| {
        let source = match specifier {
            "broken-sync" => "throw new Error('module failed'); export const ready = true;",
            "broken-async" => "await Promise.resolve(); throw new Error('async module failed'); export const ready = true;",
            "background" => "Promise.reject(new Error('background failure')); export const ready = true;",
            _ => return Err(format!("unknown module: {specifier}")),
        };
        Ok(ModuleSource { key: specifier.into(), source: source.into(), json: false, code_cache: None })
    }));
}

#[test]
fn module_evaluation_rejections_are_owned_by_the_loader() {
    setup_rejection_modules();
    for _ in 0..2 {
        let error = import_module("broken-sync").unwrap_err();
        assert_eq!(error.message, "module failed");
    }
    run_microtasks();
    assert!(take_unhandled_rejections().is_empty());
}

#[test]
fn caught_dynamic_imports_preserve_cached_error_identity_without_unhandled_events() {
    setup_rejection_modules();
    let observed = eval(r#"
        (async () => {
            const messages = [];
            for (const specifier of ['broken-sync', 'broken-async']) {
                let original;
                for (let attempt = 0; attempt < 2; attempt++) {
                    try { await import(specifier); throw new Error('unexpected namespace'); }
                    catch (error) {
                        if (attempt === 0) original = error;
                        else if (original !== error) throw new Error('changed error identity');
                        messages.push(error.message);
                    }
                }
            }
            return messages.join('|');
        })()
    "#, "module-rejections.js").unwrap();
    for _ in 0..8 { run_microtasks(); }
    match promise_state(&observed).unwrap() {
        PromiseState::Fulfilled(value) => assert_eq!(as_string(&value).as_deref(), Some(
            "module failed|module failed|async module failed|async module failed"
        )),
        PromiseState::Rejected(reason) => panic!("handled imports rejected: {}", to_string(&reason).unwrap()),
        PromiseState::Pending => panic!("handled imports stayed pending"),
    }
    assert!(take_unhandled_rejections().is_empty());
}

#[test]
fn ignored_imports_and_background_rejections_are_still_reported() {
    setup_rejection_modules();
    let ignored = eval("import('broken-sync')", "ignored-import.js").unwrap();
    for _ in 0..4 { run_microtasks(); }
    let failures = take_unhandled_rejections();
    assert_eq!(failures.len(), 1);
    assert!(strict_equal(&failures[0].0, &ignored));
    assert_eq!(to_string(&failures[0].1).unwrap(), "Error: module failed");
    import_module("background").unwrap().expect("background module evaluates");
    run_microtasks();
    let failures = take_unhandled_rejections();
    assert_eq!(failures.len(), 1);
    assert_eq!(to_string(&failures[0].1).unwrap(), "Error: background failure");
}
