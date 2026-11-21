// Included in emitted programs. Shared typed collections; no JS evaluator.
// JavaScript preserves insertion order, so the Vec remains authoritative. A
// per-map hash index accelerates hashable keys without changing enumeration
// order. Every candidate is equality-checked and a linear fallback repairs a
// missing entry after direct construction of the authoritative Vec.
#[derive(Default)]
struct NativeFingerprintHasher(u64);
impl std::hash::Hasher for NativeFingerprintHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        let mut value = 0_u64;
        for (shift, byte) in bytes.iter().take(8).enumerate() {
            value |= u64::from(*byte) << (shift * 8);
        }
        self.0 = value;
    }
    fn write_u64(&mut self, value: u64) {
        self.0 = value;
    }
}
type NativeHashIndex = std::collections::HashMap<
    u64,
    Vec<usize>,
    std::hash::BuildHasherDefault<NativeFingerprintHasher>,
>;

struct NativeKeyHasher(u64);
impl Default for NativeKeyHasher {
    fn default() -> Self {
        Self(0xcbf29ce484222325)
    }
}
impl std::hash::Hasher for NativeKeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }
}
fn native_hash_key<T: std::hash::Hash + ?Sized>(value: &T) -> u64 {
    // The result is only a candidate-bucket fingerprint: every hit is still
    // checked with JavaScript SameValueZero and collisions share a positions
    // vector. A compact non-cryptographic pass avoids paying SipHash here and
    // then paying HashMap's randomized hash again for the resulting u64.
    let mut hasher = NativeKeyHasher::default();
    std::hash::Hash::hash(value, &mut hasher);
    std::hash::Hasher::finish(&hasher)
}
fn native_number_key_hash(value: f64) -> u64 {
    let bits = if value == 0.0 {
        0_u64
    } else if value.is_nan() {
        f64::NAN.to_bits()
    } else {
        value.to_bits()
    };
    native_hash_key(&bits)
}

// Active cursors refer to the next live Vec position. Removing an earlier
// entry shifts that position; clearing the map resets it so entries appended
// by a callback remain visible. Weak cursor references do not keep callbacks
// or their maps alive.
thread_local! {
    static NATIVE_MAP_CURSORS: std::cell::RefCell<std::collections::HashMap<usize, Vec<std::rc::Weak<std::cell::Cell<usize>>>>> = std::cell::RefCell::new(std::collections::HashMap::new());
}
struct NativeMapCursor {
    owner: usize,
    index: std::rc::Rc<std::cell::Cell<usize>>,
}
impl NativeMapCursor {
    fn new(owner: usize) -> Self {
        let index = std::rc::Rc::new(std::cell::Cell::new(0));
        NATIVE_MAP_CURSORS.with(|cursors| {
            cursors.borrow_mut().entry(owner).or_default().push(std::rc::Rc::downgrade(&index));
        });
        Self { owner, index }
    }
}
impl Drop for NativeMapCursor {
    fn drop(&mut self) {
        NATIVE_MAP_CURSORS.with(|cursors| {
            let mut cursors = cursors.borrow_mut();
            if let Some(entries) = cursors.get_mut(&self.owner) {
                entries.retain(|entry| entry.upgrade().is_some_and(|entry| !std::rc::Rc::ptr_eq(&entry, &self.index)));
                if entries.is_empty() { cursors.remove(&self.owner); }
            }
        });
    }
}
fn native_map_removed(owner: usize, removed: Option<usize>) {
    NATIVE_MAP_CURSORS.with(|cursors| {
        let mut cursors = cursors.borrow_mut();
        if let Some(entries) = cursors.get_mut(&owner) {
            entries.retain(|entry| {
                let Some(index) = entry.upgrade() else { return false; };
                match removed {
                    Some(removed) if removed < index.get() => index.set(index.get() - 1),
                    None => index.set(0),
                    _ => {}
                }
                true
            });
        }
    });
}
fn native_map_foreach_callback_error(value: &NativeValue) -> ! {
    let description = match value {
        NativeValue::Undefined => "undefined".to_owned(),
        NativeValue::Null => "object null".to_owned(),
        NativeValue::Boolean(value) => format!("boolean {value}"),
        NativeValue::Number(value) => format!("number {}", js_string_number(*value)),
        NativeValue::String(value) => format!("string \"{value}\""),
        NativeValue::BigInt(_) => "bigint".to_owned(),
        NativeValue::Symbol(_) => "symbol".to_owned(),
        _ => "object".to_owned(),
    };
    runtime::throw_type_error(format!("{description} is not a function"))
}
fn js_map_set<K: NativeTrace + 'static, V: NativeTrace + 'static>(
    map: &runtime::Gc<NativeMap<K, V>>,
    key: K,
    value: V,
    hash: Option<u64>,
    equal: impl Fn(&K, &K) -> bool,
) {
    map.with_mut(|map| {
        let indexed_position = hash
            .and_then(|hash| map.hash_index.get(&hash))
            .and_then(|positions| positions.iter().copied().find(|position| map.entries.get(*position).is_some_and(|(stored, _)| equal(stored, &key))));
        if let Some(position) = indexed_position {
            map.entries[position].1 = value;
            return;
        }
        let linear_position = map
            .entries
            .iter()
            .position(|(stored, _)| equal(stored, &key));
        let position = if let Some(position) = linear_position {
            let (_, stored) = &mut map.entries[position];
            *stored = value;
            position
        } else {
            map.entries.push((key, value));
            map.entries.len() - 1
        };
        if let Some(hash) = hash {
            let positions = map.hash_index.entry(hash).or_default();
            if !positions.contains(&position) {
                positions.push(position);
            }
        }
    });
}
fn js_map_get<K: NativeTrace + 'static, V: Clone + NativeTrace + 'static>(
    map: &runtime::Gc<NativeMap<K, V>>,
    key: &K,
    hash: Option<u64>,
    equal: impl Fn(&K, &K) -> bool,
) -> Option<V> {
    map.with_mut(|map| {
        let indexed_position = hash
            .and_then(|hash| map.hash_index.get(&hash))
            .and_then(|positions| positions.iter().copied().find(|position| map.entries.get(*position).is_some_and(|(stored, _)| equal(stored, key))));
        if let Some(position) = indexed_position {
            return Some(map.entries[position].1.clone());
        }
        let linear_position = map
            .entries
            .iter()
            .position(|(stored, _)| equal(stored, key));
        if let (Some(hash), Some(position)) = (hash, linear_position) {
            let positions = map.hash_index.entry(hash).or_default();
            if !positions.contains(&position) { positions.push(position); }
        }
        linear_position.map(|position| map.entries[position].1.clone())
    })
}
fn js_map_has<K: NativeTrace + 'static, V: NativeTrace + 'static>(
    map: &runtime::Gc<NativeMap<K, V>>,
    key: &K,
    hash: Option<u64>,
    equal: impl Fn(&K, &K) -> bool,
) -> bool {
    map.with_mut(|map| {
        let indexed_position = hash
            .and_then(|hash| map.hash_index.get(&hash))
            .and_then(|positions| positions.iter().copied().find(|position| map.entries.get(*position).is_some_and(|(stored, _)| equal(stored, key))));
        if indexed_position.is_some() {
            return true;
        }
        let linear_position = map
            .entries
            .iter()
            .position(|(stored, _)| equal(stored, key));
        if let (Some(hash), Some(position)) = (hash, linear_position) {
            let positions = map.hash_index.entry(hash).or_default();
            if !positions.contains(&position) { positions.push(position); }
        }
        linear_position.is_some()
    })
}
fn js_map_delete<K: NativeTrace + 'static, V: NativeTrace + 'static>(
    map: &runtime::Gc<NativeMap<K, V>>,
    key: &K,
    hash: Option<u64>,
    equal: impl Fn(&K, &K) -> bool,
) -> bool {
    let removed = map.with_mut(|map| {
        let entries = &mut map.entries;
        let position = hash
            .and_then(|hash| map.hash_index.get(&hash))
            .and_then(|positions| positions.iter().copied().find(|position| entries.get(*position).is_some_and(|(stored, _)| equal(stored, key))))
            .or_else(|| entries.iter().position(|(stored, _)| equal(stored, key)));
        if let Some(index) = position {
            entries.remove(index);
            map.hash_index.clear();
            Some(index)
        } else {
            None
        }
    });
    if let Some(index) = removed {
        native_map_removed(map.identity(), Some(index));
        true
    } else {
        false
    }
}
fn js_map_clear<K: NativeTrace + 'static, V: NativeTrace + 'static>(
    map: &runtime::Gc<NativeMap<K, V>>,
) {
    map.with_mut(|map| {
        map.entries.clear();
        map.hash_index.clear();
    });
    native_map_removed(map.identity(), None);
}
fn js_dict_set<V>(entries: &mut Vec<(runtime::JsString, V)>, key: runtime::JsString, value: V) {
    if key == "__proto__" {
        panic!("scriptc: dictionary prototype setters are not ported");
    }
    js_data_set(entries, key, value);
}
// Own data creation (JSON and dynObjLit) never invokes a prototype setter.
fn js_data_set<V>(entries: &mut Vec<(runtime::JsString, V)>, key: runtime::JsString, value: V) {
    if let Some((_, stored)) = entries.iter_mut().find(|(stored, _)| *stored == key) {
        *stored = value;
    } else {
        entries.push((key, value));
    }
}
fn js_dict_get<V: Clone, K: runtime::JsStringSource + ?Sized>(entries: &[(runtime::JsString, V)], key: &K) -> Option<V> {
    let key = runtime::string(key);
    if let Some((_, value)) = entries.iter().find(|(stored, _)| stored == &key) {
        return Some(value.clone());
    }
    if matches!(
        key.well_formed_utf8().unwrap_or(""),
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
