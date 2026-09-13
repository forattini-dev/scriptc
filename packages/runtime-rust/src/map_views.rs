// A traced map projection owns no entries. Reads/writes convert one value and
// all structural operations delegate to the same source. Capture-free function
// pointers keep every retained heap edge visible to the cycle collector.
type MapKeyEqual<'a, K> = &'a dyn Fn(&K, &K) -> bool;
type MapKeyCompare<'a, K> = &'a dyn Fn(&K, &K) -> std::cmp::Ordering;

trait MapView<K: Clone + 'static, V: HeapValue>: Trace {
    fn source(&self) -> &dyn std::any::Any;
    fn identity(&self) -> usize;
    fn get(&self, key: &K, equal: MapKeyEqual<'_, K>) -> Option<V>;
    fn set(&self, key: K, value: V, equal: MapKeyEqual<'_, K>);
    fn has(&self, key: &K, equal: MapKeyEqual<'_, K>) -> bool;
    fn delete(&self, key: &K, equal: MapKeyEqual<'_, K>) -> bool;
    fn size(&self) -> f64;
    fn clear(&self);
    fn iter_count(&self) -> f64;
    fn iter_live(&self, index: f64) -> bool;
    fn iter_key(&self, index: f64) -> K;
    fn iter_value(&self, index: f64) -> V;
    fn iter_enter(&self);
    fn iter_exit(&self);
    fn mark_null_prototype(&self);
    fn has_null_prototype(&self) -> bool;
    fn mark_namespace(&self, compare: MapKeyCompare<'_, K>);
    fn is_namespace(&self) -> bool;
    fn mark_proxy_restricted(&self);
    fn is_proxy_restricted(&self) -> bool;
    fn set_prototype(&self, value: V);
    fn prototype(&self) -> Option<V>;
}

struct MappedMap<K: Clone + 'static, S: HeapValue, T: HeapValue> {
    source: JsMap<K, S>,
    read: fn(S) -> T,
    write: fn(T) -> S,
}

impl<K: Clone + 'static, S: HeapValue, T: HeapValue> Trace for MappedMap<K, S, T> {
    fn trace(&self, tracer: &mut Tracer<'_>) { tracer.edge(&self.source); }
}

impl<K: Clone + 'static, S: HeapValue, T: HeapValue> MapView<K, T> for MappedMap<K, S, T> {
    fn source(&self) -> &dyn std::any::Any { &self.source }
    fn identity(&self) -> usize { map_identity(&self.source) }
    fn get(&self, key: &K, equal: MapKeyEqual<'_, K>) -> Option<T> {
        map_get_by(&self.source, key, equal).map(self.read)
    }
    fn set(&self, key: K, value: T, equal: MapKeyEqual<'_, K>) {
        map_set_by(&self.source, key, (self.write)(value), equal);
    }
    fn has(&self, key: &K, equal: MapKeyEqual<'_, K>) -> bool { map_has_by(&self.source, key, equal) }
    fn delete(&self, key: &K, equal: MapKeyEqual<'_, K>) -> bool { map_delete_by(&self.source, key, equal) }
    fn size(&self) -> f64 { map_size(&self.source) }
    fn clear(&self) { map_clear(&self.source); }
    fn iter_count(&self) -> f64 { map_iter_count(&self.source) }
    fn iter_live(&self, index: f64) -> bool { map_iter_live(&self.source, index) }
    fn iter_key(&self, index: f64) -> K { map_iter_key(&self.source, index) }
    fn iter_value(&self, index: f64) -> T { (self.read)(map_iter_value(&self.source, index)) }
    fn iter_enter(&self) { map_iter_enter(&self.source); }
    fn iter_exit(&self) { map_iter_exit(&self.source); }
    fn mark_null_prototype(&self) { map_mark_null_prototype(&self.source); }
    fn has_null_prototype(&self) -> bool { map_has_null_prototype(&self.source) }
    fn mark_namespace(&self, compare: MapKeyCompare<'_, K>) { map_mark_namespace_by(&self.source, compare); }
    fn is_namespace(&self) -> bool { map_is_module_namespace(&self.source) }
    fn mark_proxy_restricted(&self) { map_mark_proxy_restricted(&self.source); }
    fn is_proxy_restricted(&self) -> bool { map_is_proxy_restricted(&self.source) }
    fn set_prototype(&self, value: T) { map_set_prototype(&self.source, (self.write)(value)); }
    fn prototype(&self) -> Option<T> { map_prototype(&self.source).map(self.read) }
}

impl<K: Clone + 'static, V: HeapValue> MapData<K, V> {
    fn entry_count(&self) -> usize {
        self.view.as_ref().map_or(self.entries.len(), |view| view.iter_count() as usize)
    }
    fn entry_key(&self, index: usize) -> Option<K> {
        match &self.view {
            Some(view) => view.iter_live(index as f64).then(|| view.iter_key(index as f64)),
            None => self.entries[index].as_ref().map(|(key, _)| key.clone()),
        }
    }
    fn entry_value(&self, index: usize) -> V {
        match &self.view {
            Some(view) => view.iter_value(index as f64),
            None => self.entries[index].as_ref().expect("scriptc: map value read from tombstone").1.clone(),
        }
    }
}

fn map_view<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) -> Option<Rc<dyn MapView<K, V>>> {
    map.with(|data| data.view.clone())
}

pub fn map_identity<K: Clone + 'static, V: HeapValue>(map: &JsMap<K, V>) -> usize {
    map.with(|data| data.view.as_ref().map_or_else(|| map.identity(), |view| view.identity()))
}

pub fn map_ptr_eq<K: Clone + 'static, S: HeapValue, T: HeapValue>(left: &JsMap<K, S>, right: &JsMap<K, T>) -> bool {
    map_identity(left) == map_identity(right)
}

pub fn map_mapped<K: Clone + 'static, S: HeapValue, T: HeapValue>(
    source: JsMap<K, S>, read: fn(S) -> T, write: fn(T) -> S,
) -> JsMap<K, T> {
    Gc::new(MapData {
        entries: Vec::new(), live: 0, iteration_depth: 0, null_prototype: false,
        module_namespace: false, proxy_restricted: false, prototype: None,
        view: Some(Rc::new(MappedMap { source, read, write })),
    })
}

/// Recover the original storage on a return crossing without copying entries.
pub fn map_mapped_source<K: Clone + 'static, S: HeapValue, T: HeapValue>(map: &JsMap<K, T>) -> Option<JsMap<K, S>> {
    let direct: &dyn std::any::Any = map;
    map.with(|data| data.view.as_ref()?.source().downcast_ref::<JsMap<K, S>>().cloned())
        .or_else(|| direct.downcast_ref::<JsMap<K, S>>().cloned())
}
