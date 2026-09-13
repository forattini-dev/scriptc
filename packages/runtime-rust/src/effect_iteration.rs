/// Each Effect execution gets a fresh cursor. Reads happen between callback
/// effects, so changes to the original collection remain visible.
pub fn effect_array_iterator<T: ArrayElement>(items: &JsArray<T>) -> impl Iterator<Item = T> + use<T> {
    let items = items.clone();
    let mut index = 0.0;
    let mut done = false;
    std::iter::from_fn(move || {
        if done || index >= array_len(&items) {
            done = true;
            return None;
        }
        let value = array_get(&items, index);
        index += 1.0;
        Some(value)
    })
}

struct EffectMapIterator<K: Clone + 'static, V: HeapValue> {
    source: Option<JsMap<K, V>>,
    index: f64,
}

impl<K: Clone + 'static, V: HeapValue> Iterator for EffectMapIterator<K, V> {
    type Item = (K, V);

    fn next(&mut self) -> Option<Self::Item> {
        let map = self.source.as_ref()?;
        while self.index < map_iter_count(map) {
            let index = self.index;
            self.index += 1.0;
            if map_iter_live(map, index) {
                return Some((map_iter_key(map, index), map_iter_value(map, index)));
            }
        }
        self.release();
        None
    }
}

impl<K: Clone + 'static, V: HeapValue> EffectMapIterator<K, V> {
    fn release(&mut self) {
        if let Some(map) = self.source.take() {
            map_iter_exit(&map);
        }
    }
}

impl<K: Clone + 'static, V: HeapValue> Drop for EffectMapIterator<K, V> {
    fn drop(&mut self) {
        self.release();
    }
}

/// Keep tombstones stable until iteration finishes or its fiber unwinds.
/// Drop releases the guard on failure, interruption and callback panics too.
pub fn effect_map_iterator<K: Clone + 'static, V: HeapValue>(
    map: &JsMap<K, V>,
) -> impl Iterator<Item = (K, V)> + use<K, V> {
    map_iter_enter(map);
    EffectMapIterator { source: Some(map.clone()), index: 0.0 }
}
