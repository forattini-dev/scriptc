use super::*;

#[derive(Default)]
struct Value {
    edges: Vec<Gc<Value>>,
}
impl Trace for Value {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for edge in &self.edges {
            tracer.edge(edge);
        }
    }
}
impl ClearEdges for Value {
    fn clear_edges(&mut self) {
        self.edges.clear();
    }
}
fn node() -> Gc<Value> {
    Gc::new(Value::default())
}

#[test]
fn weak_map_identity_overwrite_absence_and_delete() {
    collect_cycles();
    let before = live_heap_objects();
    {
        let owner = node();
        let other = node();
        let key = node();
        let different = node();
        let o = WeakKey::new(&owner);
        let k = WeakKey::new(&key);
        weak_map_set(&o, &k, 1.0);
        weak_map_set(&o, &k, 2.0);
        assert_eq!(weak_map_get::<f64>(&o, &k), Some(2.0));
        assert!(!weak_map_has::<f64>(&WeakKey::new(&other), &k));
        assert!(!weak_map_has::<f64>(&o, &WeakKey::new(&different)));
        assert!(weak_map_delete::<f64>(&o, &k));
        assert!(!weak_map_delete::<f64>(&o, &k));
        assert_eq!(weak_map_get::<f64>(&o, &k), None);
        let optional_owner = node();
        let optional = WeakKey::new(&optional_owner);
        weak_map_set::<Option<f64>>(&optional, &k, None);
        assert_eq!(weak_map_get::<Option<f64>>(&optional, &k), Some(None));
        assert!(weak_map_has::<Option<f64>>(&optional, &k));
    }
    collect_cycles();
    assert_eq!(live_heap_objects(), before);
}

#[test]
fn weak_map_collects_a_value_pointing_back_to_its_key() {
    collect_cycles();
    let before = live_heap_objects();
    {
        let owner = node();
        let key = node();
        let value = Gc::new(Value {
            edges: vec![key.clone()],
        });
        let dead_key = key.downgrade();
        let dead_value = value.downgrade();
        weak_map_set(&WeakKey::new(&owner), &WeakKey::new(&key), value.clone());
        drop(key);
        drop(value);
        collect_cycles();
        assert!(dead_key.upgrade().is_none());
        assert!(dead_value.upgrade().is_none());
        assert_eq!(live_heap_objects(), before + 1);
    }
    collect_cycles();
    assert_eq!(live_heap_objects(), before);
}

#[test]
fn weak_membership_table_does_not_retain_a_cyclic_key_or_dead_owner() {
    collect_cycles();
    let before = live_heap_objects();
    let owner = node();
    let table = node();
    owner.with_mut(|value| value.edges.push(table.clone()));
    let key = node();
    key.with_mut(|value| value.edges.push(key.clone()));
    let dead_key = key.downgrade();
    let dead_table = table.downgrade();
    let table_id = WeakKey::new(&table);
    let key_id = WeakKey::new(&key);
    weak_map_set(&table_id, &key_id, true);
    drop(table);
    drop(key);
    collect_cycles();
    assert!(dead_key.upgrade().is_none());
    assert!(!weak_map_has::<bool>(&table_id, &key_id));
    assert!(dead_table.upgrade().is_some());
    assert_eq!(live_heap_objects(), before + 2);
    drop(owner);
    collect_cycles();
    assert!(dead_table.upgrade().is_none());
    assert_eq!(live_heap_objects(), before);
}

#[test]
fn weak_map_fixed_point_keeps_a_chain_until_the_first_key_dies() {
    collect_cycles();
    let before = live_heap_objects();
    {
        let owner = node();
        let key = node();
        let second = node();
        let tail = node();
        let value = Gc::new(Value {
            edges: vec![second.clone()],
        });
        let weak_second = second.downgrade();
        let weak_tail = tail.downgrade();
        // Reverse registration order requires a second marking round.
        weak_map_set(&WeakKey::new(&owner), &WeakKey::new(&second), tail.clone());
        weak_map_set(&WeakKey::new(&owner), &WeakKey::new(&key), value.clone());
        drop(second);
        drop(tail);
        drop(value);
        collect_cycles();
        assert!(weak_second.upgrade().is_some());
        assert!(weak_tail.upgrade().is_some());
        drop(key);
        collect_cycles();
        assert!(weak_second.upgrade().is_none());
        assert!(weak_tail.upgrade().is_none());
    }
    collect_cycles();
    assert_eq!(live_heap_objects(), before);
}

#[test]
fn weak_map_keys_cannot_resurrect_each_other_through_values() {
    collect_cycles();
    let before = live_heap_objects();
    {
        let owner = node();
        let first = node();
        let second = node();
        let weak_first = first.downgrade();
        let weak_second = second.downgrade();
        weak_map_set(&WeakKey::new(&owner), &WeakKey::new(&first), second.clone());
        weak_map_set(&WeakKey::new(&owner), &WeakKey::new(&second), first.clone());
        drop(first);
        drop(second);
        collect_cycles();
        assert!(weak_first.upgrade().is_none());
        assert!(weak_second.upgrade().is_none());
    }
    collect_cycles();
    assert_eq!(live_heap_objects(), before);
}

#[test]
fn weak_map_a_live_key_does_not_retain_a_dead_owner_via_its_value() {
    collect_cycles();
    let before = live_heap_objects();
    {
        let owner = node();
        let key = node();
        let value = Gc::new(Value {
            edges: vec![owner.clone()],
        });
        let weak_owner = owner.downgrade();
        let weak_value = value.downgrade();
        weak_map_set(&WeakKey::new(&owner), &WeakKey::new(&key), value.clone());
        drop(owner);
        drop(value);
        collect_cycles();
        assert!(weak_owner.upgrade().is_none());
        assert!(weak_value.upgrade().is_none());
        assert_eq!(live_heap_objects(), before + 1);
    }
    collect_cycles();
    assert_eq!(live_heap_objects(), before);
}

#[test]
fn weak_map_dead_scalar_entries_are_pruned_without_cycle_candidates() {
    collect_cycles();
    {
        let owner = node();
        let key = node();
        weak_map_set(&WeakKey::new(&owner), &WeakKey::new(&key), 9.0);
    }
    collect_cycles();
    assert!(weak_map_snapshot().is_empty());
}
