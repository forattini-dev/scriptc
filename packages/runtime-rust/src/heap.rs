impl Tracer<'_> {
    pub fn edge<T>(&mut self, edge: &Gc<T>)
    where
        T: Trace + ClearEdges + 'static,
    {
        let node: DynNodeRc = edge.rc().clone();
        (self.visit)(Rc::downgrade(&node));
    }
}

/// Enumerates every owning heap edge in a payload.
pub trait Trace {
    fn trace(&self, tracer: &mut Tracer<'_>);
}

/// Removes every owning heap edge from a payload.
///
/// Collection calls this only for a set proven unreachable. Implementations
/// must leave scalar data valid, but may empty containers and `take()` object
/// fields. This explicit operation is what lets safe Rust break `Rc` cycles.
pub trait ClearEdges {
    fn clear_edges(&mut self);
}

struct Node<T> {
    id: usize,
    value: RefCell<T>,
}

impl<T> DynNode for Node<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn id(&self) -> usize {
        self.id
    }

    fn trace(&self, tracer: &mut Tracer<'_>) {
        self.value.borrow().trace(tracer);
    }

    fn clear_edges(&self) {
        self.value.borrow_mut().clear_edges();
    }
}

impl<T> Drop for Node<T> {
    fn drop(&mut self) {
        // Native process exit runs TLS destructors in an unspecified order.
        // A program-owned TLS may release its final Gc after the runtime's
        // counters have already gone away; there is nothing left to audit in
        // that phase, so teardown must not turn a requested exit into a panic.
        let _ = LIVE_NODES.try_with(|count| count.set(count.get() - 1));
    }
}

/// Owned, address-stable handle for JavaScript heap objects.
///
/// `Gc<T>` deliberately exposes closure-based borrows instead of Rust
/// references whose lifetime could escape a runtime operation. Cloning a
/// handle preserves JavaScript identity. Dropping a handle records a weak
/// cycle candidate; `collect_cycles` performs safe trial deletion later.
pub struct Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    inner: Option<Rc<Node<T>>>,
}

impl<T> Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    pub fn new(value: T) -> Self {
        let id = NEXT_NODE_ID.with(|next| {
            let id = next.get();
            next.set(id.checked_add(1).expect("scriptc: heap id overflow"));
            id
        });
        LIVE_NODES.with(|count| count.set(count.get() + 1));
        Self {
            inner: Some(Rc::new(Node {
                id,
                value: RefCell::new(value),
            })),
        }
    }

    pub fn with<R>(&self, read: impl FnOnce(&T) -> R) -> R {
        read(&self.rc().value.borrow())
    }

    pub fn with_mut<R>(&self, write: impl FnOnce(&mut T) -> R) -> R {
        write(&mut self.rc().value.borrow_mut())
    }

    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(self.rc(), other.rc())
    }

    pub fn identity(&self) -> usize {
        self.rc().id
    }

    /// Creates a non-owning handle suitable for callbacks stored by this object.
    pub fn downgrade(&self) -> GcWeak<T> {
        GcWeak {
            inner: Rc::downgrade(self.rc()),
        }
    }

    fn rc(&self) -> &Rc<Node<T>> {
        self.inner.as_ref().expect("scriptc: moved heap handle")
    }
}

/// Non-owning counterpart to [`Gc`], used to avoid runtime-created cycles.
pub struct GcWeak<T>
where
    T: Trace + ClearEdges + 'static,
{
    inner: Weak<Node<T>>,
}

impl<T> GcWeak<T>
where
    T: Trace + ClearEdges + 'static,
{
    pub fn upgrade(&self) -> Option<Gc<T>> {
        self.inner.upgrade().map(|inner| Gc { inner: Some(inner) })
    }
}

impl<T> Clone for GcWeak<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl<T> Clone for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn clone(&self) -> Self {
        Self {
            inner: Some(self.rc().clone()),
        }
    }
}

impl<T> Drop for Gc<T>
where
    T: Trace + ClearEdges + 'static,
{
    fn drop(&mut self) {
        let Some(node) = self.inner.take() else {
            return;
        };
        let erased: DynNodeRc = node.clone();
        let candidate = Rc::downgrade(&erased);
        drop(erased);
        drop(node);
        if candidate.strong_count() > 0 {
            let _ = CYCLE_CANDIDATES
                .try_with(|candidates| candidates.borrow_mut().push(candidate));
        }
    }
}

/// Dropped-alias candidates that trigger an incremental collection pass.
///
/// Tracing borrows every candidate node, so collection is only safe between
/// callbacks; the event loop applies this threshold at its dispatch safe
/// point rather than inside `Gc::drop`, where a traced node may still be
/// mutably borrowed.
const CYCLE_PRESSURE_THRESHOLD: usize = 4096;

/// Run a collection pass when enough drop candidates have accumulated.
///
/// Every aliased handle drop records a candidate, so a long-running program
/// that never collected until exit would retain each candidate's node
/// allocation through its `Weak`. Draining on pressure bounds that growth.
pub fn collect_cycles_if_pressured() -> usize {
    let pressured =
        CYCLE_CANDIDATES.with(|buffer| buffer.borrow().len() >= CYCLE_PRESSURE_THRESHOLD);
    if pressured { collect_cycles() } else { 0 }
}

/// Collect cycles reachable from handles whose reference count decreased.
///
/// The pass snapshots the candidate subgraph, subtracts its internal edges
/// from each node's strong count, marks nodes with outside owners as live,
/// then clears edges only in the unmarked remainder. Working references are
/// explicitly discounted, so the collector itself never keeps garbage live.
pub fn collect_cycles() -> usize {
    let candidates = CYCLE_CANDIDATES.with(|buffer| std::mem::take(&mut *buffer.borrow_mut()));
    let mut nodes = Vec::<DynNodeRc>::new();
    let mut positions = HashMap::<usize, usize>::new();
    let mut queue = VecDeque::<DynNodeRc>::new();

    for candidate in candidates {
        if let Some(node) = candidate.upgrade()
            && !positions.contains_key(&node.id())
        {
            positions.insert(node.id(), nodes.len());
            nodes.push(node.clone());
            queue.push_back(node);
        }
    }

    while let Some(node) = queue.pop_front() {
        node.trace(&mut Tracer {
            visit: &mut |child| {
                let Some(child) = child.upgrade() else {
                    return;
                };
                if positions.contains_key(&child.id()) {
                    return;
                }
                positions.insert(child.id(), nodes.len());
                nodes.push(child.clone());
                queue.push_back(child);
            },
        });
    }

    if nodes.is_empty() {
        return 0;
    }

    let mut incoming = vec![0usize; nodes.len()];
    for node in &nodes {
        node.trace(&mut Tracer {
            visit: &mut |child| {
                if let Some(child) = child.upgrade()
                    && let Some(index) = positions.get(&child.id())
                {
                    incoming[*index] += 1;
                }
            },
        });
    }

    let mut live = HashSet::<usize>::new();
    let mut live_queue = VecDeque::<usize>::new();
    for (index, node) in nodes.iter().enumerate() {
        // One strong reference per node belongs to `nodes`; every other
        // reference not represented by an incoming edge is an outside root.
        let outside = Rc::strong_count(node).saturating_sub(1 + incoming[index]);
        if outside > 0 && live.insert(node.id()) {
            live_queue.push_back(index);
        }
    }

    while let Some(index) = live_queue.pop_front() {
        nodes[index].trace(&mut Tracer {
            visit: &mut |child| {
                let Some(child) = child.upgrade() else {
                    return;
                };
                let Some(child_index) = positions.get(&child.id()).copied() else {
                    return;
                };
                if live.insert(child.id()) {
                    live_queue.push_back(child_index);
                }
            },
        });
    }

    let garbage: Vec<_> = nodes
        .iter()
        .filter(|node| !live.contains(&node.id()))
        .cloned()
        .collect();
    let collected = garbage.len();
    for node in &garbage {
        node.clear_edges();
    }
    drop(garbage);
    drop(nodes);
    collected
}
