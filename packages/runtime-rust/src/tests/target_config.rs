#[test]
fn target_defaults_to_the_matrix_primary_and_configures_per_thread() {
    assert_eq!(target_runtime_id(), "node24");
    assert_eq!(target_node_version(), NODE_COMPAT_VERSION);
    assert_eq!(target_readable_bare_read(), ReadRule::CollapseQueue);
    assert_eq!(process_versions_node(), string(NODE_COMPAT_VERSION));
    target_configure(TargetConfig {
        runtime_id: "node26",
        node_version: "26.8.1",
        readable_bare_read: ReadRule::HeadChunk,
    });
    assert_eq!(target_runtime_id(), "node26");
    assert_eq!(target_readable_bare_read(), ReadRule::HeadChunk);
    assert_eq!(process_versions_node(), string("26.8.1"));
    // Thread-local: another thread still sees the primary.
    let other = std::thread::spawn(|| (target_runtime_id(), target_readable_bare_read()))
        .join()
        .expect("thread");
    assert_eq!(other, ("node24", ReadRule::CollapseQueue));
    target_configure(PRIMARY_TARGET);
}
