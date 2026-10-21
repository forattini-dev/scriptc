//! Coinductive equality for closed data layouts, independent of declaration IDs.
//! Mutable fields stay invariant. Containers with distinct concrete storage are
//! deliberately outside this relation until they have owning view adapters.
use super::*;

pub fn equivalent(left: &Type, right: &Type, records: &[Record], unions: &[Union]) -> bool {
    fn visit(
        left: &Type,
        right: &Type,
        records: &[Record],
        unions: &[Union],
        active: &mut Vec<(Type, Type, usize)>,
        depth: usize,
    ) -> bool {
        if left == right {
            return true;
        }
        if let Some((_, _, entered)) = active.iter().find(|(a, b, _)| a == left && b == right) {
            return depth > *entered;
        }
        active.push((left.clone(), right.clone(), depth));
        let result = match (left, right) {
            (Type::Record { shape_id: a }, Type::Record { shape_id: b }) => {
                records.get(*a).zip(records.get(*b)).is_some_and(|(a, b)| {
                    closed(a)
                        && closed(b)
                        && a.fields.len() == b.fields.len()
                        && a.fields.iter().all(|field| {
                            b.fields
                                .iter()
                                .find(|f| f.name == field.name)
                                .is_some_and(|other| {
                                    visit(
                                        &field.r#type,
                                        &other.r#type,
                                        records,
                                        unions,
                                        active,
                                        depth + 1,
                                    )
                                })
                        })
                })
            }
            (Type::Union { union_id: a }, Type::Union { union_id: b }) => {
                unions.get(*a).zip(unions.get(*b)).is_some_and(|(a, b)| {
                    !a.arms.is_empty()
                        && a.arms.len() == b.arms.len()
                        && a.arms.iter().all(|arm| {
                            b.arms
                                .iter()
                                .filter(|other| visit(arm, other, records, unions, active, depth))
                                .count()
                                == 1
                        })
                        && b.arms.iter().all(|arm| {
                            a.arms
                                .iter()
                                .filter(|other| visit(other, arm, records, unions, active, depth))
                                .count()
                                == 1
                        })
                })
            }
            _ => false,
        };
        active.pop();
        result
    }
    visit(left, right, records, unions, &mut Vec::new(), 0)
}

fn closed(record: &Record) -> bool {
    !record.tuple
        && record.index_value.is_none()
        && !record.fields.iter().any(|f| f.name == "\0scriptc.call")
}

/// Bucket by field names before comparing graphs. Equivalent record markers
/// may cross a checked read without copying their shared property store.
pub fn record_representatives(records: &[Record], unions: &[Union]) -> Vec<usize> {
    let mut buckets: HashMap<Vec<&str>, Vec<Vec<usize>>> = HashMap::new();
    for record in records.iter().filter(|r| closed(r)) {
        let mut names = record
            .fields
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>();
        names.sort_unstable();
        let classes = buckets.entry(names).or_default();
        if let Some(class) = classes.iter_mut().find(|class| {
            equivalent(
                &Type::Record { shape_id: class[0] },
                &Type::Record {
                    shape_id: record.id,
                },
                records,
                unions,
            )
        }) {
            class.push(record.id);
        } else {
            classes.push(vec![record.id]);
        }
    }
    let mut result = records.iter().map(|r| r.id).collect::<Vec<_>>();
    for class in buckets.into_values().flatten() {
        for id in &class {
            result[*id] = class[0];
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: usize, value: Type, next: usize) -> Record {
        Record {
            id,
            fields: vec![
                Field {
                    name: "next".into(),
                    r#type: Type::Union { union_id: next },
                },
                Field {
                    name: "value".into(),
                    r#type: value,
                },
            ],
            declared_order: vec!["value".into(), "next".into()],
            tuple: false,
            index_value: None,
        }
    }
    fn node(id: usize) -> Type {
        Type::Record { shape_id: id }
    }
    fn layouts() -> (Vec<Record>, Vec<Union>) {
        (
            vec![record(0, Type::F64, 0), record(1, Type::F64, 1)],
            vec![
                Union {
                    id: 0,
                    arms: vec![node(0), Type::Undefined],
                },
                Union {
                    id: 1,
                    arms: vec![Type::Undefined, node(1)],
                },
            ],
        )
    }

    #[test]
    fn equivalent_back_edges_preserve_invariant_siblings_and_runtime_tags() {
        let (mut records, unions) = layouts();
        assert!(equivalent(&node(0), &node(1), &records, &unions));
        assert_eq!(record_representatives(&records, &unions), vec![0, 0]);
        assert_eq!(
            record_views::view_pairs(&node(0), &node(1), &records, &unions),
            Some(vec![(0, 0)])
        );
        records[1].fields[1].r#type = Type::String;
        assert!(!equivalent(&node(0), &node(1), &records, &unions));
        assert_eq!(record_representatives(&records, &unions), vec![0, 1]);
        assert!(record_views::view_pairs(&node(0), &node(1), &records, &unions).is_none());
    }

    #[test]
    fn recursive_fields_do_not_admit_nested_width_or_different_container_storage() {
        let (mut records, unions) = layouts();
        records[1].fields.push(Field {
            name: "extra".into(),
            r#type: Type::Bool,
        });
        assert!(!equivalent(&node(0), &node(1), &records, &unions));
        // A width view cannot erase an extra field required through a later
        // recursive write into its invariant `next` slot.
        assert!(record_views::view_pairs(&node(1), &node(0), &records, &unions).is_none());
        let array = |elem| Type::Array {
            elem: Box::new(elem),
        };
        assert!(!equivalent(
            &array(node(0)),
            &array(node(1)),
            &records,
            &unions
        ));
        records[1].fields.pop();
        records[1].tuple = true;
        assert!(!equivalent(&node(0), &node(1), &records, &unions));
        records[1].tuple = false;
        records[1].index_value = Some(Type::F64);
        assert!(!equivalent(&node(0), &node(1), &records, &unions));
    }

    #[test]
    fn malformed_and_ambiguous_union_graphs_do_not_prove_equivalence() {
        let (records, mut unions) = layouts();
        unions[0].arms = vec![Type::Union { union_id: 0 }, Type::Undefined];
        unions[1].arms = vec![Type::Union { union_id: 1 }, Type::Undefined];
        assert!(!equivalent(
            &Type::Union { union_id: 0 },
            &Type::Union { union_id: 1 },
            &records,
            &unions
        ));
        unions[0].arms = vec![node(0), node(1)];
        unions[1].arms = vec![node(1), node(0)];
        assert!(!equivalent(
            &Type::Union { union_id: 0 },
            &Type::Union { union_id: 1 },
            &records,
            &unions
        ));
        assert!(!equivalent(&node(0), &node(99), &records, &unions));
    }

    #[test]
    fn nullable_views_remap_unit_tags_without_dropping_any_source_arm() {
        let (records, mut unions) = layouts();
        unions.push(Union {
            id: 2,
            arms: vec![node(0), Type::Null, Type::Undefined],
        });
        unions.push(Union {
            id: 3,
            arms: vec![Type::Undefined, node(1), Type::Null],
        });
        assert_eq!(
            record_views::view_pairs(
                &Type::Union { union_id: 2 },
                &Type::Union { union_id: 3 },
                &records,
                &unions
            ),
            Some(vec![(0, 1), (1, 2), (2, 0)])
        );
        assert!(
            record_views::view_pairs(&Type::Union { union_id: 2 }, &node(1), &records, &unions)
                .is_none()
        );
        assert!(
            record_views::view_pairs(&Type::Union { union_id: 99 }, &node(1), &records, &unions)
                .is_none()
        );
    }
}
