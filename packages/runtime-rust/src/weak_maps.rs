// Conditional owning values indexed by non-owning map and key identities.
// Generated backends use one payload ABI for each nominal WeakMap owner.

#[derive(Clone)]
pub struct WeakKey {
    id: usize,
    node: DynNodeWeak,
}

impl WeakKey {
    pub fn new<T: Trace + ClearEdges + 'static>(value: &Gc<T>) -> Self {
        let node: DynNodeRc = value.rc().clone();
        Self {
            id: node.id(),
            node: Rc::downgrade(&node),
        }
    }
    fn alive(&self) -> bool {
        self.node.strong_count() != 0
    }
}

struct WeakEntry<V> {
    owner: WeakKey,
    key: WeakKey,
    value: V,
}
struct WeakEntries<V> {
    entries: RefCell<Vec<WeakEntry<V>>>,
}
struct Ephemeron {
    owner: WeakKey,
    key: WeakKey,
    edges: Vec<DynNodeWeak>,
}

trait EphemeronTable {
    fn snapshot(&self, output: &mut Vec<Ephemeron>);
    fn retain_live(&self, live: &HashSet<usize>);
}

impl<V: HeapValue> EphemeronTable for WeakEntries<V> {
    fn snapshot(&self, output: &mut Vec<Ephemeron>) {
        for entry in self.entries.borrow().iter() {
            let mut edges = Vec::new();
            entry.value.trace_value(&mut Tracer {
                visit: &mut |edge| edges.push(edge),
            });
            output.push(Ephemeron {
                owner: entry.owner.clone(),
                key: entry.key.clone(),
                edges,
            });
        }
    }
    fn retain_live(&self, live: &HashSet<usize>) {
        self.entries
            .borrow_mut()
            .retain(|entry| live.contains(&entry.owner.id) && live.contains(&entry.key.id));
    }
}

struct WeakTableRegistration {
    table: Rc<dyn EphemeronTable>,
    payload: Rc<dyn Any>,
}
thread_local! {
    static WEAK_TABLES: RefCell<HashMap<std::any::TypeId, WeakTableRegistration>> = RefCell::new(HashMap::new());
}

fn weak_table<V: HeapValue>() -> Rc<WeakEntries<V>> {
    WEAK_TABLES.with(|tables| {
        let mut tables = tables.borrow_mut();
        let entry = tables
            .entry(std::any::TypeId::of::<V>())
            .or_insert_with(|| {
                let value = Rc::new(WeakEntries::<V> {
                    entries: RefCell::new(Vec::new()),
                });
                WeakTableRegistration {
                    table: value.clone(),
                    payload: value,
                }
            });
        entry
            .payload
            .clone()
            .downcast::<WeakEntries<V>>()
            .expect("scriptc: weak payload ABI")
    })
}

fn weak_map_snapshot() -> Vec<Ephemeron> {
    let mut result = Vec::new();
    WEAK_TABLES.with(|tables| {
        for table in tables.borrow().values() {
            table.table.snapshot(&mut result);
        }
    });
    result
}

fn weak_map_retain_live(live: &HashSet<usize>) {
    WEAK_TABLES.with(|tables| {
        for table in tables.borrow().values() {
            table.table.retain_live(live);
        }
    });
}

pub fn weak_map_set<V: HeapValue>(owner: &WeakKey, key: &WeakKey, value: V) {
    let table = weak_table::<V>();
    let mut entries = table.entries.borrow_mut();
    entries.retain(|entry| entry.owner.alive() && entry.key.alive());
    if let Some(entry) = entries
        .iter_mut()
        .find(|entry| entry.owner.id == owner.id && entry.key.id == key.id)
    {
        entry.value = value;
    } else {
        entries.push(WeakEntry {
            owner: owner.clone(),
            key: key.clone(),
            value,
        });
    }
}

pub fn weak_map_get<V: HeapValue>(owner: &WeakKey, key: &WeakKey) -> Option<V> {
    let table = weak_table::<V>();
    let mut entries = table.entries.borrow_mut();
    entries.retain(|entry| entry.owner.alive() && entry.key.alive());
    entries
        .iter()
        .find(|entry| entry.owner.id == owner.id && entry.key.id == key.id)
        .map(|entry| entry.value.clone())
}

pub fn weak_map_has<V: HeapValue>(owner: &WeakKey, key: &WeakKey) -> bool {
    let table = weak_table::<V>();
    let mut entries = table.entries.borrow_mut();
    entries.retain(|entry| entry.owner.alive() && entry.key.alive());
    entries
        .iter()
        .any(|entry| entry.owner.id == owner.id && entry.key.id == key.id)
}

pub fn weak_map_delete<V: HeapValue>(owner: &WeakKey, key: &WeakKey) -> bool {
    let table = weak_table::<V>();
    let mut entries = table.entries.borrow_mut();
    entries.retain(|entry| entry.owner.alive() && entry.key.alive());
    if let Some(index) = entries
        .iter()
        .position(|entry| entry.owner.id == owner.id && entry.key.id == key.id)
    {
        entries.remove(index);
        true
    } else {
        false
    }
}

#[cfg(test)]
#[path = "weak_maps.test.rs"]
mod weak_maps_tests;
