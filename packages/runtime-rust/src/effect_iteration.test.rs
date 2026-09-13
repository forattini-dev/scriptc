#[test]
fn effect_map_iterator_releases_tombstones_and_stays_done() {
    let map = map_new::<JsString, f64>();
    map_set_by(&map, string("a"), 1.0, |a, b| a == b);
    map_set_by(&map, string("b"), 2.0, |a, b| a == b);
    let mut iterator = effect_map_iterator(&map);
    assert_eq!(iterator.next(), Some((string("a"), 1.0)));
    map_delete_by(&map, &string("b"), |a, b| a == b);
    map_set_by(&map, string("c"), 3.0, |a, b| a == b);
    assert_eq!(map_iter_count(&map), 3.0);
    assert_eq!(iterator.next(), Some((string("c"), 3.0)));
    assert_eq!(iterator.next(), None);
    assert_eq!(map_iter_count(&map), 2.0);
    map_set_by(&map, string("d"), 4.0, |a, b| a == b);
    assert_eq!(iterator.next(), None);
}

#[test]
fn effect_foreach_releases_map_iteration_on_all_exits() {
    for failure in [effect_fail(effect_box(1.0)), effect_die(effect_box(2.0)), effect_new(EffectNode::Interrupt)] {
        let map = map_new::<JsString, f64>();
        map_set_by(&map, string("a"), 1.0, |a, b| a == b);
        map_set_by(&map, string("b"), 2.0, |a, b| a == b);
        let source = map.clone();
        let callback_map = map.clone();
        let effect = effect_for_each(
            Rc::new(move || Box::new(effect_map_iterator(&source).map(effect_box))),
            Rc::new(move |_, _| {
                map_delete_by(&callback_map, &string("b"), |a, b| a == b);
                failure.clone()
            }),
            Rc::new(|_| effect_box(())),
            Box::new(|_| {}),
        );
        let exit = effect_unbox::<JsEffect>(&effect_run_sync(&effect_exit(&effect)));
        assert!(!effect_exit_is_success(&exit));
        assert_eq!(map_iter_count(&map), 1.0, "unwinding must release tombstones");
    }
}
