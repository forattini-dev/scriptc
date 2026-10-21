#[test]
fn promise_properties_share_future_writes_across_payload_views() {
    init();
    let baseline = live_heap_objects();
    {
        let source = promise_new::<f64>();
        let handle = promise_to_mapped_handle(&source, |value| string(&value.to_string()));
        let view = promise_view_from_handle::<JsString>(&handle);
        assert!(promise_own_get::<_, JsString>(&view, "child").is_none());
        promise_own_set(&source, "child", string("first"));
        promise_own_set(&source, "extra", 42.0);
        assert_eq!(
            promise_own_get::<_, JsString>(&view, "child")
                .unwrap()
                .as_ref(),
            "first"
        );
        promise_own_set(&view, "child", string("second"));
        assert_eq!(
            promise_own_get::<_, JsString>(&source, "child")
                .unwrap()
                .as_ref(),
            "second"
        );
        assert_eq!(promise_own_keys(&source), ["child", "extra"]);
        assert!(promise_fulfill(&source, 3.0));
        assert_eq!(
            promise_poll(&view)
                .unwrap()
                .unwrap_or_else(|_| panic!("unexpected rejection"))
                .as_ref(),
            "3"
        );
        assert!(promise_own_delete(&view, "child"));
        assert!(promise_own_get::<_, JsString>(&source, "child").is_none());
        promise_own_set(&source, "child", string("third"));
        assert_eq!(promise_own_keys(&view), ["extra", "child"]);
    }
    finish();
    assert_eq!(live_heap_objects(), baseline);
}

#[test]
fn promise_properties_follow_object_identity_instead_of_settlement_adoption() {
    init();
    let baseline = live_heap_objects();
    {
        let source = promise_resolved(3.0);
        promise_own_set(&source, "child", string("source"));
        let adopted = promise_from_handle::<f64>(&promise_to_handle(&source));
        assert_ne!(
            promise_view_identity(&source),
            promise_view_identity(&adopted)
        );
        assert!(promise_own_get::<_, JsString>(&adopted, "child").is_none());
        run_event_loop();
        assert!(matches!(promise_poll(&adopted), Some(Ok(3.0))));
    }
    finish();
    assert_eq!(live_heap_objects(), baseline);
}

#[test]
fn promise_properties_trace_cycles_and_retain_external_aliases() {
    init();
    let baseline = live_heap_objects();
    let outside = {
        let source = promise_resolved(4.0);
        let view = promise_view_map(&source, |value| value + 1.0);
        promise_own_set(&source, "self", source.clone());
        promise_own_set(&view, "view", view.clone());
        view
    };
    collect_cycles();
    assert!(matches!(promise_poll(&outside), Some(Ok(5.0))));
    let source = promise_own_get::<_, JsPromise<f64>>(&outside, "self").unwrap();
    assert!(matches!(promise_poll(&source), Some(Ok(4.0))));
    drop(source);
    drop(outside);
    collect_cycles();
    assert_eq!(live_heap_objects(), baseline);
    finish();
}
