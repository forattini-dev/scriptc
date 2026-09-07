#[test]
fn synchronous_byte_reads_do_not_accumulate_duplicate_cycle_candidates() {
    collect_cycles();
    let bytes = bytes_from_vec(vec![17u8]);
    for _ in 0..100_000 {
        let argument = bytes.clone();
        assert_eq!(bytes_get(&argument, 0.0), 17.0);
    }
    CYCLE_CANDIDATES.with(|buffer| {
        assert!(buffer.borrow().len() <= 1, "one live backing must have at most one pending candidate");
    });
    // A surviving candidate can be recorded again after a collection pass.
    collect_cycles();
    drop(bytes.clone());
    CYCLE_CANDIDATES.with(|buffer| assert_eq!(buffer.borrow().len(), 1));
    drop(bytes);
    collect_cycles();
}

#[test]
fn synchronous_temporary_objects_do_not_retain_unbounded_dead_candidates() {
    collect_cycles();
    let baseline = live_heap_objects();
    for _ in 0..100_000 {
        let bytes = bytes_from_vec(vec![17u8]);
        drop(bytes.clone());
    }
    assert_eq!(live_heap_objects(), baseline);
    CYCLE_CANDIDATES.with(|buffer| {
        assert!(buffer.borrow().len() <= CYCLE_PRESSURE_THRESHOLD, "dead weak allocations must be pruned without tracing borrowed nodes");
    });
    collect_cycles();
}
