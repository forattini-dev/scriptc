pub struct MapData<K: Clone + 'static, V: HeapValue> {
    entries: Vec<Option<(K, V)>>,
    live: usize,
    iteration_depth: usize,
}

impl<K: Clone + 'static, V: HeapValue> Trace for MapData<K, V> {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for entry in &self.entries {
            if let Some((_, value)) = entry {
                value.trace_value(tracer);
            }
        }
    }
}

impl<K: Clone + 'static, V: HeapValue> ClearEdges for MapData<K, V> {
    fn clear_edges(&mut self) {
        self.entries.clear();
    }
}

pub type JsMap<K, V> = Gc<MapData<K, V>>;

pub fn map_new<K: Clone + 'static, V: HeapValue>() -> JsMap<K, V> {
    Gc::new(MapData {
        entries: Vec::new(),
        live: 0,
        iteration_depth: 0,
    })
}

pub fn map_set_by<K, V, F>(map: &JsMap<K, V>, key: K, value: V, equal: F)
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with_mut(|data| {
        if let Some((_, stored)) = data
            .entries
            .iter_mut()
            .flatten()
            .find(|(stored, _)| equal(stored, &key))
        {
            *stored = value;
        } else {
            data.entries.push(Some((key, value)));
            data.live += 1;
        }
    });
}

pub fn map_get_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> Option<V>
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with(|data| {
        data.entries
            .iter()
            .flatten()
            .find(|(stored, _)| equal(stored, key))
            .map(|(_, value)| value.clone())
    })
}

pub fn map_has_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> bool
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with(|data| {
        data.entries
            .iter()
            .flatten()
            .any(|(stored, _)| equal(stored, key))
    })
}

pub fn map_delete_by<K, V, F>(map: &JsMap<K, V>, key: &K, equal: F) -> bool
where
    K: Clone + 'static,
    V: HeapValue,
    F: Fn(&K, &K) -> bool,
{
    map.with_mut(|data| {
        let Some(index) = data
            .entries
            .iter()
            .position(|entry| entry.as_ref().is_some_and(|(stored, _)| equal(stored, key)))
        else {
            return false;
        };
        data.entries[index] = None;
        data.live -= 1;
        if data.iteration_depth == 0 {
            data.entries.retain(Option::is_some);
        }
        true
    })
}

pub fn map_size<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) -> f64 {
    map.with(|data| data.live as f64)
}

pub fn map_clear<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| {
        data.live = 0;
        if data.iteration_depth == 0 {
            data.entries.clear();
        } else {
            for entry in &mut data.entries {
                *entry = None;
            }
        }
    });
}

pub fn map_iter_count<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) -> f64 {
    map.with(|data| data.entries.len() as f64)
}

pub fn map_iter_live<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> bool {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| data.entries[index].is_some())
}

pub fn map_iter_key<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> K {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| {
        data.entries[index]
            .as_ref()
            .expect("scriptc: map key read from a tombstone")
            .0
            .clone()
    })
}

pub fn map_iter_value<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>, index: f64) -> V {
    let index = array_index(index, false, map.with(|data| data.entries.len()));
    map.with(|data| {
        data.entries[index]
            .as_ref()
            .expect("scriptc: map value read from a tombstone")
            .1
            .clone()
    })
}

pub fn map_iter_enter<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| data.iteration_depth += 1);
}

pub fn map_iter_exit<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) {
    map.with_mut(|data| {
        data.iteration_depth = data
            .iteration_depth
            .checked_sub(1)
            .expect("scriptc: unbalanced map iteration exit");
        if data.iteration_depth == 0 {
            data.entries.retain(Option::is_some);
        }
    });
}

fn js_property_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

fn map_string_entry_order<V: HeapValue>(data: &MapData<JsString, V>) -> Vec<usize> {
    let mut indexes = Vec::new();
    let mut names = Vec::new();
    for (position, entry) in data.entries.iter().enumerate() {
        let Some((key, _)) = entry else { continue };
        if let Some(index) = js_property_index(key) {
            indexes.push((index, position));
        } else {
            names.push(position);
        }
    }
    indexes.sort_unstable_by_key(|(index, _)| *index);
    indexes
        .into_iter()
        .map(|(_, position)| position)
        .chain(names)
        .collect()
}

pub fn map_string_keys_js_order<V: HeapValue>(map: &JsMap<JsString, V>) -> JsArray<JsString> {
    array_new(map.with(|data| {
        map_string_entry_order(data)
            .into_iter()
            .map(|position| {
                data.entries[position]
                    .as_ref()
                    .expect("scriptc: ordered map key points at a tombstone")
                    .0
                    .clone()
            })
            .collect()
    }))
}

pub type JsSet<T> = JsMap<T, bool>;

pub fn set_new<T: Clone + 'static>() -> JsSet<T> {
    map_new()
}

pub fn set_from_array_by<T, N, F>(source: &JsArray<T>, normalize: N, equal: F) -> JsSet<T>
where
    T: ArrayElement,
    N: Fn(T) -> T,
    F: Fn(&T, &T) -> bool + Copy,
{
    let set = set_new();
    let values = source.with(|data| data.elements.clone());
    for value in values {
        map_set_by(&set, normalize(value), true, equal);
    }
    set
}

pub fn set_add_by<T, F>(set: &JsSet<T>, value: T, equal: F)
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_set_by(set, value, true, equal);
}

pub fn set_has_by<T, F>(set: &JsSet<T>, value: &T, equal: F) -> bool
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_has_by(set, value, equal)
}

pub fn set_delete_by<T, F>(set: &JsSet<T>, value: &T, equal: F) -> bool
where
    T: Clone + 'static,
    F: Fn(&T, &T) -> bool,
{
    map_delete_by(set, value, equal)
}

pub fn set_to_array<T: ArrayElement>(set: &JsSet<T>) -> JsArray<T> {
    let values = set.with(|data| {
        data.entries
            .iter()
            .filter_map(|entry| entry.as_ref().map(|(value, _)| value.clone()))
            .collect()
    });
    array_new(values)
}
