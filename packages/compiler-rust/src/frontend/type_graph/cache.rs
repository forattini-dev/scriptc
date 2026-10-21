//! A root only changes new entries: completed types are read from the cache.
//! Journal those discoveries so failure costs scale with that root's work,
//! rather than cloning the complete program's type graph for every query.
use super::*;

#[derive(Default)]
pub(in crate::frontend) struct TypeCache {
    states: HashMap<TypeId, Resolution>,
    journal: Vec<TypeId>,
}

impl TypeCache {
    pub(in crate::frontend) fn get(&self, id: &TypeId) -> Option<&Resolution> {
        self.states.get(id)
    }

    pub(in crate::frontend) fn get_mut(&mut self, id: &TypeId) -> Option<&mut Resolution> {
        self.states.get_mut(id)
    }

    pub(in crate::frontend) fn insert(&mut self, id: TypeId, state: Resolution) {
        if self.states.insert(id, state).is_none() {
            self.journal.push(id);
        }
    }

    pub(in crate::frontend) fn mark(&self) -> usize {
        self.journal.len()
    }

    pub(in crate::frontend) fn failed_layout(&self, mark: usize) -> bool {
        self.journal[mark..].iter().any(|id| {
            matches!(
                self.states.get(id),
                Some(Resolution::Failed { reference: Some(_) })
            )
        })
    }

    pub(in crate::frontend) fn rollback(&mut self, mark: usize) {
        for id in self.journal.drain(mark..) {
            self.states.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollback_removes_only_discovered_types_and_reuses_failed_identities() {
        let mut cache = TypeCache::default();
        cache.insert(TypeId(1), Resolution::Ready(Type::String));
        let mark = cache.mark();
        cache.insert(
            TypeId(2),
            Resolution::Resolving {
                kind: LayoutKind::Record,
                reference: None,
            },
        );
        cache.insert(TypeId(2), Resolution::Ready(Type::Record { shape_id: 0 }));
        cache.insert(
            TypeId(3),
            Resolution::Failed {
                reference: Some(Type::Union { union_id: 0 }),
            },
        );
        assert!(cache.failed_layout(mark));
        cache.rollback(mark);
        assert!(matches!(
            cache.get(&TypeId(1)),
            Some(Resolution::Ready(Type::String))
        ));
        assert!(cache.get(&TypeId(2)).is_none());
        assert!(cache.get(&TypeId(3)).is_none());
        assert_eq!(cache.mark(), mark);
        cache.insert(TypeId(2), Resolution::Ready(Type::Bool));
        assert!(!cache.failed_layout(mark));
        cache.rollback(mark);
        assert!(cache.get(&TypeId(2)).is_none());
    }
}
