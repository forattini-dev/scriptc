// Included in emitted programs. Shared typed collections; no JS evaluator.
fn js_map_set<K: NativeTrace + 'static, V: NativeTrace + 'static>(
    map: &runtime::Gc<NativeMap<K, V>>,
    key: K,
    value: V,
    equal: impl Fn(&K, &K) -> bool,
) {
    map.with_mut(|map| {
        let entries = &mut map.entries;
        if let Some((_, stored)) = entries.iter_mut().find(|(stored, _)| equal(stored, &key)) {
            *stored = value;
        } else {
            entries.push((key, value));
        }
    });
}
fn js_map_get<K: NativeTrace + 'static, V: Clone + NativeTrace + 'static>(
    map: &runtime::Gc<NativeMap<K, V>>,
    key: &K,
    equal: impl Fn(&K, &K) -> bool,
) -> Option<V> {
    map.with(|map| {
        map.entries
            .iter()
            .find(|(stored, _)| equal(stored, key))
            .map(|(_, value)| value.clone())
    })
}
fn js_map_has<K: NativeTrace + 'static, V: NativeTrace + 'static>(
    map: &runtime::Gc<NativeMap<K, V>>,
    key: &K,
    equal: impl Fn(&K, &K) -> bool,
) -> bool {
    map.with(|map| map.entries.iter().any(|(stored, _)| equal(stored, key)))
}
fn js_map_delete<K: NativeTrace + 'static, V: NativeTrace + 'static>(
    map: &runtime::Gc<NativeMap<K, V>>,
    key: &K,
    equal: impl Fn(&K, &K) -> bool,
) -> bool {
    map.with_mut(|map| {
        let entries = &mut map.entries;
        if let Some(index) = entries.iter().position(|(stored, _)| equal(stored, key)) {
            entries.remove(index);
            true
        } else {
            false
        }
    })
}
fn js_dict_set<V>(entries: &mut Vec<(String, V)>, key: String, value: V) {
    if key == "__proto__" {
        panic!("scriptc: dictionary prototype setters are not ported");
    }
    js_data_set(entries, key, value);
}
// Own data creation (JSON and dynObjLit) never invokes a prototype setter.
fn js_data_set<V>(entries: &mut Vec<(String, V)>, key: String, value: V) {
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
