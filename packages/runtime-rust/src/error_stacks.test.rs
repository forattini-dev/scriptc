#[test]
fn source_stack_capture_aliases_cache_and_recapture() {
    error_stacks_finish();
    let error = error_new("Error", string("first"));
    let alias = error.clone();
    {
        let _frame = source_stack_push("make", "make", "/source.cjs", 3, 7);
        error_capture_stack(&error);
    }
    error_set_message(&alias, string("before read"));
    assert_eq!(error_stack(&error).as_ref(), "Error: before read\n    at make (/source.cjs:3:7)");
    error_set_message(&error, string("after read"));
    assert_eq!(error_stack(&alias).as_ref(), "Error: before read\n    at make (/source.cjs:3:7)");
    error_capture_stack(&alias);
    assert_eq!(error_stack(&error).as_ref(), "Error: after read");
    drop((alias, error));
    finish();
    assert_eq!(live_heap_objects(), 0);
}

#[test]
fn source_stack_guards_unwind_and_constructor_cut_uses_identity() {
    error_stacks_finish();
    let error = error_new("Error", string("cut"));
    let _outer = source_stack_push("caller", "caller", "/source.cjs", 8, 2);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _constructor = source_stack_push("ctor-id", "renamed", "/source.cjs", 4, 5);
        let _inner = source_stack_push("inner", "inner", "/source.cjs", 2, 3);
        error_capture_stack_excluding(&error, &string("ctor-id"));
        panic!("unwind test");
    }));
    assert!(result.is_err());
    assert_eq!(error_stack(&error).as_ref(), "Error: cut\n    at caller (/source.cjs:8:2)");
    error_capture_stack(&error);
    assert_eq!(error_stack(&error).as_ref(), "Error: cut\n    at caller (/source.cjs:8:2)");
    error_capture_stack_excluding(&error, &string("absent"));
    assert_eq!(error_stack(&error).as_ref(), "Error: cut");
    drop((_outer, error));
    finish();
}

#[test]
fn source_stack_gc_cache_is_weak_and_formats_outside_its_borrow() {
    error_stacks_finish();
    let target = array_new::<JsString>(vec![]);
    let other = array_new::<JsString>(vec![]);
    let weak = target.downgrade();
    error_capture_stack_gc(&target, None);
    let reads = Cell::new(0);
    let stack = error_stack_gc(&target, || {
        reads.set(reads.get() + 1);
        error_capture_stack_gc(&other, None);
        string("header")
    });
    assert_eq!(stack.as_ref(), "header");
    assert_eq!(error_stack_gc(&target, || panic!("cached header must not run")).as_ref(), "header");
    assert_eq!(reads.get(), 1);
    drop((target, other));
    collect_cycles();
    assert!(weak.upgrade().is_none());
    assert_eq!(live_heap_objects(), 0);
    finish();
}
