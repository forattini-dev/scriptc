// Included in emitted programs. Shared typed collections; no JS evaluator.
fn js_map_set<K, V>(
    map: &std::rc::Rc<std::cell::RefCell<Vec<(K, V)>>>,
    key: K,
    value: V,
    equal: impl Fn(&K, &K) -> bool,
) {
    let mut entries = map.borrow_mut();
    if let Some((_, stored)) = entries.iter_mut().find(|(stored, _)| equal(stored, &key)) {
        *stored = value;
    } else {
        entries.push((key, value));
    }
}
fn js_map_get<K, V: Clone>(
    map: &std::rc::Rc<std::cell::RefCell<Vec<(K, V)>>>,
    key: &K,
    equal: impl Fn(&K, &K) -> bool,
) -> Option<V> {
    map.borrow()
        .iter()
        .find(|(stored, _)| equal(stored, key))
        .map(|(_, value)| value.clone())
}
fn js_map_has<K, V>(
    map: &std::rc::Rc<std::cell::RefCell<Vec<(K, V)>>>,
    key: &K,
    equal: impl Fn(&K, &K) -> bool,
) -> bool {
    map.borrow().iter().any(|(stored, _)| equal(stored, key))
}
fn js_map_delete<K, V>(
    map: &std::rc::Rc<std::cell::RefCell<Vec<(K, V)>>>,
    key: &K,
    equal: impl Fn(&K, &K) -> bool,
) -> bool {
    let mut entries = map.borrow_mut();
    if let Some(index) = entries.iter().position(|(stored, _)| equal(stored, key)) {
        entries.remove(index);
        true
    } else {
        false
    }
}
fn js_dict_set<V>(entries: &mut Vec<(String, V)>, key: String, value: V) {
    if key == "__proto__" {
        panic!("scriptc: dictionary prototype setters are not ported");
    }
    if let Some((_, stored)) = entries.iter_mut().find(|(stored, _)| *stored == key) {
        *stored = value;
    } else {
        entries.push((key, value));
    }
}
fn js_dict_get<V: Clone>(entries: &[(String, V)], key: &str) -> Option<V> {
    if let Some((_, value)) = entries.iter().find(|(stored, _)| stored == key) {
        return Some(value.clone());
    }
    if matches!(
        key,
        "constructor"
            | "__proto__"
            | "__defineGetter__"
            | "__defineSetter__"
            | "__lookupGetter__"
            | "__lookupSetter__"
            | "hasOwnProperty"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "toLocaleString"
            | "toString"
            | "valueOf"
    ) {
        panic!("scriptc: inherited dictionary properties are not ported");
    }
    None
}
