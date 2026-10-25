//! Invariant field views preserve identity and all properties in the backing store.
use super::*;

pub fn view_pairs(
    source: &Type,
    target: &Type,
    records: &[Record],
    unions: &[Union],
) -> Option<Vec<(usize, usize)>> {
    fn arms(ty: &Type, unions: &[Union]) -> Option<Vec<Type>> {
        match ty {
            Type::Union { union_id } => unions.get(*union_id).map(|u| u.arms.clone()),
            _ => Some(vec![ty.clone()]),
        }
    }
    fn optional(ty: &Type, unions: &[Union]) -> bool {
        *ty == Type::Undefined
            || matches!(ty, Type::Union { union_id } if unions.get(*union_id).is_some_and(|u| u.arms.contains(&Type::Undefined)))
    }
    let targets = arms(target, unions)?;
    let sources = arms(source, unions)?;
    if !sources.iter().any(|t| matches!(t, Type::Record { .. })) {
        return None;
    }
    sources
        .iter()
        .enumerate()
        .map(|(from, ty)| {
            let Type::Record { shape_id } = ty else {
                if !matches!(ty, Type::Null | Type::Undefined) {
                    return None;
                }
                let choices = targets
                    .iter()
                    .enumerate()
                    .filter(|(_, target)| *target == ty)
                    .collect::<Vec<_>>();
                return (choices.len() == 1).then(|| (from, choices[0].0));
            };
            let source = records.get(*shape_id)?;
            if source.tuple
                || source.index_value.is_some()
                || source.fields.iter().any(|f| f.name == "\0scriptc.call")
                || contains_set(ty, records, unions)
            {
                return None;
            }
            let choices = targets
                .iter()
                .enumerate()
                .filter_map(|(to, ty)| {
                    let Type::Record { shape_id } = ty else {
                        return None;
                    };
                    let target = records.get(*shape_id)?;
                    (!target.tuple
                        && target.index_value.is_none()
                        && !target.fields.iter().any(|f| f.name == "\0scriptc.call")
                        && !contains_set(ty, records, unions)
                        && target.fields.iter().all(|f| {
                            match source.fields.iter().find(|old| old.name == f.name) {
                                Some(old) => super::record_equivalence::equivalent(
                                    &old.r#type,
                                    &f.r#type,
                                    records,
                                    unions,
                                ),
                                // A view exposes an absent optional key without
                                // defining it or copying the shared property store.
                                None => optional(&f.r#type, unions),
                            }
                        }))
                    .then_some(to)
                })
                .collect::<Vec<_>>();
            (choices.len() == 1).then(|| (from, choices[0]))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: usize, fields: &[(&str, Type)]) -> Record {
        Record {
            id,
            fields: fields
                .iter()
                .map(|(name, ty)| Field {
                    name: (*name).into(),
                    r#type: ty.clone(),
                })
                .collect(),
            declared_order: fields.iter().map(|(name, _)| (*name).into()).collect(),
            tuple: false,
            index_value: None,
        }
    }
    #[test]
    fn invariant_width_views_map_tags_independently_of_destination_order() {
        let records = vec![
            record(0, &[("a", Type::String), ("extra", Type::Bool)]),
            record(1, &[("b", Type::F64), ("extra", Type::Bool)]),
            record(2, &[("b", Type::F64)]),
            record(3, &[("a", Type::String)]),
        ];
        let unions = vec![
            Union {
                id: 0,
                arms: vec![Type::Record { shape_id: 0 }, Type::Record { shape_id: 1 }],
            },
            Union {
                id: 1,
                arms: vec![Type::Record { shape_id: 2 }, Type::Record { shape_id: 3 }],
            },
        ];
        assert_eq!(
            view_pairs(
                &Type::Union { union_id: 0 },
                &Type::Union { union_id: 1 },
                &records,
                &unions
            ),
            Some(vec![(0, 1), (1, 0)])
        );
    }
    #[test]
    fn views_refuse_field_changes_tuple_storage_and_ambiguous_targets() {
        let mut records = vec![
            record(0, &[("a", Type::String), ("extra", Type::Bool)]),
            record(1, &[("a", Type::F64)]),
            record(2, &[("a", Type::String)]),
        ];
        let unions = vec![Union {
            id: 0,
            arms: vec![Type::Record { shape_id: 0 }, Type::Record { shape_id: 2 }],
        }];
        assert!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 1 },
                &records,
                &unions
            )
            .is_none()
        );
        assert!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Union { union_id: 0 },
                &records,
                &unions
            )
            .is_none()
        );
        records[0].tuple = true;
        assert!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 2 },
                &records,
                &unions
            )
            .is_none()
        );
    }
    #[test]
    fn absent_optional_fields_preserve_nullable_view_mapping() {
        let optional = Type::Union { union_id: 0 };
        let records = vec![
            record(0, &[("width", optional.clone())]),
            record(1, &[("width", optional.clone()), ("height", optional)]),
        ];
        let unions = vec![
            Union {
                id: 0,
                arms: vec![Type::F64, Type::Undefined],
            },
            Union {
                id: 1,
                arms: vec![Type::Record { shape_id: 0 }, Type::Undefined],
            },
            Union {
                id: 2,
                arms: vec![Type::Undefined, Type::Record { shape_id: 1 }],
            },
        ];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 1 },
                &records,
                &unions
            ),
            Some(vec![(0, 0)])
        );
        assert_eq!(
            view_pairs(
                &Type::Union { union_id: 1 },
                &Type::Union { union_id: 2 },
                &records,
                &unions
            ),
            Some(vec![(0, 1), (1, 0)])
        );
    }
    #[test]
    fn optional_views_refuse_mutable_changes_required_fields_and_nominal_targets() {
        let optional = Type::Union { union_id: 0 };
        let mut records = vec![
            record(0, &[("width", Type::F64)]),
            record(1, &[("width", optional.clone())]),
            record(2, &[("width", Type::F64), ("height", Type::F64)]),
            record(3, &[("width", Type::F64), ("height", optional.clone())]),
            record(4, &[("width", Type::F64), ("depth", optional.clone())]),
            record(5, &[("width", Type::F64), ("\0scriptc.call", optional)]),
        ];
        let unions = vec![
            Union {
                id: 0,
                arms: vec![Type::F64, Type::Undefined],
            },
            Union {
                id: 1,
                arms: vec![Type::Record { shape_id: 3 }, Type::Record { shape_id: 4 }],
            },
            Union {
                id: 2,
                arms: vec![
                    Type::Set {
                        elem: Box::new(Type::String),
                    },
                    Type::Undefined,
                ],
            },
        ];
        for shape_id in [1, 2, 5] {
            assert!(
                view_pairs(
                    &Type::Record { shape_id: 0 },
                    &Type::Record { shape_id },
                    &records,
                    &unions
                )
                .is_none()
            );
        }
        assert!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Union { union_id: 1 },
                &records,
                &unions
            )
            .is_none()
        );
        records.push(record(
            6,
            &[("width", Type::F64), ("set", Type::Union { union_id: 2 })],
        ));
        assert!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 6 },
                &records,
                &unions
            )
            .is_none()
        );
    }
}
