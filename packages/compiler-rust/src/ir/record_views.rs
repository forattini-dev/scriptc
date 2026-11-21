//! Invariant field views preserve identity and all properties in the backing store.
use super::*;

fn same_field_name(left: &str, right: &str) -> bool {
    left == right
        || ["@iterator@", "@asyncIterator@", "@toStringTag@"]
            .into_iter()
            .any(|marker| left.contains(marker) && right.contains(marker))
}

fn reaches_record(ty: &Type, target: usize, records: &[Record], unions: &[Union]) -> bool {
    fn visit(
        ty: &Type,
        target: usize,
        records: &[Record],
        unions: &[Union],
        seen: &mut std::collections::HashSet<Type>,
    ) -> bool {
        if !seen.insert(ty.clone()) {
            return false;
        }
        match ty {
            Type::Record { shape_id } => {
                *shape_id == target
                    || records.get(*shape_id).is_some_and(|record| {
                        record
                            .fields
                            .iter()
                            .any(|field| visit(&field.r#type, target, records, unions, seen))
                    })
            }
            Type::Union { union_id } => unions.get(*union_id).is_some_and(|union| {
                union
                    .arms
                    .iter()
                    .any(|arm| visit(arm, target, records, unions, seen))
            }),
            Type::Array { elem } | Type::Set { elem } | Type::Promise { inner: elem } => {
                visit(elem, target, records, unions, seen)
            }
            Type::Map { key, value } => {
                visit(key, target, records, unions, seen)
                    || visit(value, target, records, unions, seen)
            }
            Type::Func { params, ret, .. } => {
                params
                    .iter()
                    .any(|param| visit(param, target, records, unions, seen))
                    || visit(ret, target, records, unions, seen)
            }
            _ => false,
        }
    }
    visit(
        ty,
        target,
        records,
        unions,
        &mut std::collections::HashSet::new(),
    )
}

pub fn view_pairs(
    source: &Type,
    target: &Type,
    records: &[Record],
    unions: &[Union],
) -> Option<Vec<(usize, usize)>> {
    view_pairs_with_mode(source, target, records, unions, false, false)
        .or_else(|| view_pairs_with_mode(source, target, records, unions, true, false))
}

/// A dynamically checked view shares the same property store. Typed reads
/// still validate values after writes through either view.
pub fn dynamic_view_pairs(
    source: &Type,
    target: &Type,
    records: &[Record],
    unions: &[Union],
) -> Option<Vec<(usize, usize)>> {
    view_pairs(source, target, records, unions)
        .or_else(|| view_pairs_with_mode(source, target, records, unions, true, true))
}

fn view_pairs_with_mode(
    source: &Type,
    target: &Type,
    records: &[Record],
    unions: &[Union],
    allow_callback_width: bool,
    allow_optional_widening: bool,
) -> Option<Vec<(usize, usize)>> {
    fn arms(ty: &Type, unions: &[Union]) -> Option<Vec<Type>> {
        match ty {
            Type::Union { union_id } => unions.get(*union_id).map(|u| u.arms.clone()),
            _ => Some(vec![ty.clone()]),
        }
    }
    fn optional(ty: &Type, unions: &[Union]) -> bool {
        matches!(ty, Type::Dyn | Type::Undefined)
            || matches!(ty, Type::Union { union_id } if unions.get(*union_id).is_some_and(|u| u.arms.contains(&Type::Undefined)))
    }
    fn field_view_compatible_inner(
        source: &Type,
        target: &Type,
        records: &[Record],
        unions: &[Union],
        depth: usize,
        allow_callback_width: bool,
        allow_optional_widening: bool,
        active: &mut Vec<(Type, Type)>,
    ) -> bool {
        if source == target {
            return true;
        }
        // Web platform records such as Response and Blob contain methods
        // whose Promise payloads point back to another projection of the
        // same record graph. Treat a pair already being compared as the
        // coinductive back-edge of one shared checked view; the surrounding
        // fields still have to prove compatibility before that pair is seen.
        if active
            .iter()
            .any(|(left, right)| left == source && right == target)
        {
            if let (
                Type::Record {
                    shape_id: source_id,
                },
                Type::Record {
                    shape_id: target_id,
                },
            ) = (source, target)
            {
                let (Some(source_record), Some(target_record)) =
                    (records.get(*source_id), records.get(*target_id))
                else {
                    return false;
                };
                let source_fields = &source_record.fields;
                let target_fields = &target_record.fields;
                // A recursive mutable slot can later receive a value through
                // either view. Width conversion at this back-edge would let a
                // narrow write drop fields required by the wider view.
                if source_fields.len() != target_fields.len()
                    || source_fields
                        .iter()
                        .zip(target_fields)
                        .any(|(source, target)| !same_field_name(&source.name, &target.name))
                {
                    return false;
                }
            }
            return true;
        }
        if depth >= 64 {
            return false;
        }
        active.push((source.clone(), target.clone()));
        let compatible = (|| {
            // Closed records store every property as NativeValue. An erased view
            // is therefore memory-safe even when it admits undefined; typed reads
            // through the original view retain their runtime brand checks.
            if *target == Type::Dyn {
                return true;
            }
            if super::callable_view_compatible(source, target) {
                return true;
            }
            // Promise payloads are produced once and observed covariantly. Their
            // closed-record payloads may therefore share the same structural view
            // used by a direct field, while unrelated primitive payloads remain
            // incompatible in the generic callable ABI.
            if let (
                Type::Promise {
                    inner: source_inner,
                },
                Type::Promise {
                    inner: target_inner,
                },
            ) = (source, target)
            {
                if **target_inner == Type::Void && **source_inner != Type::Void {
                    // A Promise<void> observer discards its fulfillment
                    // value. The shared promise handle still carries that
                    // value for observers of the original view.
                    return true;
                }
                return field_view_compatible_inner(
                    source_inner,
                    target_inner,
                    records,
                    unions,
                    depth + 1,
                    allow_callback_width,
                    allow_optional_widening,
                    active,
                );
            }
            if let Type::Union { union_id } = source
                && let Some(source_union) = unions.get(*union_id)
                && !source_union.arms.is_empty()
                && source_union.arms.iter().all(|source_arm| {
                    field_view_compatible_inner(
                        source_arm,
                        target,
                        records,
                        unions,
                        depth + 1,
                        allow_callback_width,
                        allow_optional_widening,
                        active,
                    )
                })
            {
                // A field can acquire several storage ABIs as control flow
                // merges assignments (for example `T[]` and the `any[]`
                // produced by Array.isArray(JSON.parse(...).items)).  The
                // property store erases those arms to one NativeValue.  A
                // checked record view may expose the merged field as T when
                // every possible source arm can itself back that view; typed
                // reads and writes retain the mapped array/record checks.
                return true;
            }
            if let (Type::Array { elem: source_elem }, Type::Array { elem: target_elem }) =
                (source, target)
            {
                // Arrays are identity-bearing mutable containers backed by the
                // checked array view ABI. A callable field may therefore expose
                // Array<Dyn> as Array<T> (or the reverse) while reads and writes
                // continue to validate both element contracts. Closed element
                // ABIs still need one recursive match so a union such as
                // `VNode[] | string[]` does not make every array arm compatible
                // with every other arm.
                return **source_elem != Type::Void
                    && **target_elem != Type::Void
                    && !contains_set(source_elem, records, unions)
                    && !contains_set(target_elem, records, unions)
                    && (**source_elem == Type::Dyn
                        || **target_elem == Type::Dyn
                        || field_view_compatible_inner(
                            source_elem,
                            target_elem,
                            records,
                            unions,
                            depth + 1,
                            allow_callback_width,
                            allow_optional_widening,
                            active,
                        ));
            }
            // A source callback may back a target callback when every argument
            // accepted by the target is also accepted by the source. Records
            // therefore flow in the opposite direction for parameters, while
            // the result flows from source to target.
            if allow_callback_width
                && let (
                    Type::Func {
                        params: source_params,
                        ret: source_ret,
                        rest: source_rest,
                    },
                    Type::Func {
                        params: target_params,
                        ret: target_ret,
                        rest: target_rest,
                    },
                ) = (source, target)
                && source_rest == target_rest
                && (source_params.len() == target_params.len()
                    || (!*source_rest && source_params.len() < target_params.len()))
                && target_params
                    .iter()
                    .zip(source_params)
                    .all(|(target, source)| {
                        field_view_compatible_inner(
                            target,
                            source,
                            records,
                            unions,
                            depth + 1,
                            allow_callback_width,
                            allow_optional_widening,
                            active,
                        )
                    })
                && field_view_compatible_inner(
                    source_ret,
                    target_ret,
                    records,
                    unions,
                    depth + 1,
                    allow_callback_width,
                    allow_optional_widening,
                    active,
                )
            {
                return true;
            }
            // Record views share mutable storage. Exposing a required field as
            // optional would permit a later write of `undefined` through the view
            // and violate the source shape's invariant.
            if !allow_optional_widening && optional(target, unions) && !optional(source, unions) {
                return false;
            }
            // A dynamic property store can be exposed through a checked typed
            // view without changing object identity. Reads through the narrow
            // record perform the native brand check and writes remain a subset of
            // values accepted by the dynamic source slot. Arrays use their
            // existing checked mapped view, including recursive record elements.
            if *source == Type::Dyn {
                let target_arms = match target {
                    Type::Union { union_id } => {
                        unions.get(*union_id).map(|union| union.arms.as_slice())
                    }
                    _ => None,
                };
                let target_arms = target_arms.unwrap_or(std::slice::from_ref(target));
                if !target_arms.is_empty()
                && target_arms.iter().all(|arm| {
                    matches!(
                        arm,
                        Type::F64
                            | Type::Bigint
                            | Type::String
                            | Type::Bool
                            | Type::Symbol
                            | Type::Null
                            | Type::Undefined
                    ) || matches!(arm, Type::Func { .. } if !contains_set(arm, records, unions))
                    || matches!(arm, Type::Array { elem } if **elem != Type::Void && !contains_set(arm, records, unions))
                    || matches!(arm, Type::Record { shape_id } if records.get(*shape_id).is_some_and(|record| {
                        !record.tuple
                            && !record.fields.iter().any(|field| field.name == "\0scriptc.call")
                            && !contains_set(arm, records, unions)
                    }))
                })
            {
                return true;
            }
            }
            if allow_optional_widening
                && let Type::Union { union_id } = source
                && let Some(source_union) = unions.get(*union_id)
                && source_union
                    .arms
                    .iter()
                    .any(|source_arm| matches!(source_arm, Type::Null | Type::Undefined))
                && source_union.arms.iter().all(|source_arm| {
                    matches!(source_arm, Type::Null | Type::Undefined)
                        || super::record_equivalence::equivalent(
                            source_arm, target, records, unions,
                        )
                })
                && source_union.arms.iter().any(|source_arm| {
                    super::record_equivalence::equivalent(source_arm, target, records, unions)
                })
            {
                // A checked view may narrow T | nullish to T. The backing slot
                // remains shared: reads through the required view validate the
                // current NativeValue, while writes of T are also valid through
                // the optional source view. This is the converse of optional
                // widening and is intentionally unavailable to invariant views.
                return true;
            }
            if allow_optional_widening
                && matches!(source, Type::Record { .. })
                && let Type::Union { union_id } = target
                && let Some(target_union) = unions.get(*union_id)
            {
                // A checked structural view may expose a present record as an
                // optional record. The property store remains shared; the
                // emitter wraps the existing record handle in the target
                // union arm when that field is read. Require one unique
                // present arm so no runtime shape guess is involved.
                let present = target_union
                    .arms
                    .iter()
                    .filter(|arm| !matches!(arm, Type::Null | Type::Undefined))
                    .filter(|arm| {
                        field_view_compatible_inner(
                            source,
                            arm,
                            records,
                            unions,
                            depth + 1,
                            allow_callback_width,
                            allow_optional_widening,
                            active,
                        )
                    })
                    .count();
                if present == 1
                    && target_union.arms.iter().all(|arm| {
                        matches!(
                            arm,
                            Type::Null
                                | Type::Undefined
                                | Type::String
                                | Type::F64
                                | Type::Bool
                                | Type::Bigint
                                | Type::Array { .. }
                                | Type::Record { .. }
                        )
                    })
                {
                    return true;
                }
            }
            if let (
                Type::Record {
                    shape_id: source_id,
                },
                Type::Record {
                    shape_id: target_id,
                },
            ) = (source, target)
                && let (Some(source_record), Some(target_record)) =
                    (records.get(*source_id), records.get(*target_id))
                && allow_optional_widening
                && !source_record.tuple
                && !target_record.tuple
                && source_record.index_value.is_none()
                && let Some(target_index) = target_record.index_value.as_ref()
                && source_record.fields.len() == target_record.fields.len()
                && source_record.fields.iter().all(|field| {
                    target_record
                        .fields
                        .iter()
                        .find(|other| same_field_name(&other.name, &field.name))
                        .is_some_and(|other| {
                            field_view_compatible_inner(
                                &field.r#type,
                                &other.r#type,
                                records,
                                unions,
                                depth + 1,
                                allow_callback_width,
                                allow_optional_widening,
                                active,
                            )
                        })
                        && field_view_compatible_inner(
                            &field.r#type,
                            target_index,
                            records,
                            unions,
                            depth + 1,
                            allow_callback_width,
                            allow_optional_widening,
                            active,
                        )
                })
            {
                // A checked JSON index view can add unknown keys to a closed
                // record. The named slots keep their own checked field views.
                return true;
            }
            if let (
                Type::Record {
                    shape_id: source_id,
                },
                Type::Record {
                    shape_id: target_id,
                },
            ) = (source, target)
                && let (Some(source_record), Some(target_record)) =
                    (records.get(*source_id), records.get(*target_id))
                && !source_record.tuple
                && !target_record.tuple
                && let (Some(source_index), Some(target_index)) = (
                    source_record.index_value.as_ref(),
                    target_record.index_value.as_ref(),
                )
                && !source_record.fields.is_empty()
                && source_record.fields.len() == target_record.fields.len()
                && source_record.fields.iter().all(|field| {
                    target_record
                        .fields
                        .iter()
                        .find(|other| same_field_name(&other.name, &field.name))
                        .is_some_and(|other| {
                            field_view_compatible_inner(
                                &field.r#type,
                                &other.r#type,
                                records,
                                unions,
                                depth + 1,
                                allow_callback_width,
                                allow_optional_widening,
                                active,
                            )
                        })
                })
                && field_view_compatible_inner(
                    source_index,
                    target_index,
                    records,
                    unions,
                    depth + 1,
                    allow_callback_width,
                    allow_optional_widening,
                    active,
                )
                && field_view_compatible_inner(
                    target_index,
                    source_index,
                    records,
                    unions,
                    depth + 1,
                    allow_callback_width,
                    allow_optional_widening,
                    active,
                )
            {
                // Interfaces that extend a JSON dictionary retain both
                // named fields and an index contract. Their nested views can
                // share storage when both directions validate the index and
                // every named field has a checked view.
                return true;
            }
            if let (
                Type::Record {
                    shape_id: source_id,
                },
                Type::Record {
                    shape_id: target_id,
                },
            ) = (source, target)
                && let (Some(source_record), Some(target_record)) =
                    (records.get(*source_id), records.get(*target_id))
                && allow_optional_widening
                && !source_record.tuple
                && !target_record.tuple
                && source_record.fields.is_empty()
                && target_record.fields.is_empty()
                && let (Some(source_index), Some(target_index)) = (
                    source_record.index_value.as_ref(),
                    target_record.index_value.as_ref(),
                )
                && !contains_set(source, records, unions)
                && !contains_set(target, records, unions)
            {
                // Two recursive dictionaries may have distinct checker shape
                // ids while sharing the same NativeValue property store.
                // Compare their value views coinductively and check typed
                // reads through either alias after writes.
                return field_view_compatible_inner(
                    source_index,
                    target_index,
                    records,
                    unions,
                    depth + 1,
                    allow_callback_width,
                    allow_optional_widening,
                    active,
                );
            }
            if let (
                Type::Record {
                    shape_id: source_id,
                },
                Type::Record {
                    shape_id: target_id,
                },
            ) = (source, target)
                && let (Some(source_record), Some(target_record)) =
                    (records.get(*source_id), records.get(*target_id))
                && allow_optional_widening
                && !source_record.tuple
                && !target_record.tuple
                && source_record.index_value.is_none()
                && target_record.fields.is_empty()
                && let Some(index) = target_record.index_value.as_ref()
            {
                // A fixed-field object can back a recursive JSON dictionary
                // through the shared property store. Every present field
                // must have a checked view into the dictionary's value union.
                return source_record.fields.iter().all(|field| {
                    field_view_compatible_inner(
                        &field.r#type,
                        index,
                        records,
                        unions,
                        depth + 1,
                        allow_callback_width,
                        allow_optional_widening,
                        active,
                    )
                });
            }
            if let (
                Type::Record {
                    shape_id: source_id,
                },
                Type::Record {
                    shape_id: target_id,
                },
            ) = (source, target)
                && let (Some(source_record), Some(target_record)) =
                    (records.get(*source_id), records.get(*target_id))
                && allow_optional_widening
                && !source_record.tuple
                && source_record.fields.is_empty()
                && let Some(index) = source_record.index_value.as_ref()
                && !target_record.tuple
                && target_record.index_value.is_none()
                && !contains_set(target, records, unions)
            {
                // A Record<string, unknown> can back a fixed-field view at
                // any nesting depth. Missing optional keys stay absent; reads
                // through the typed view check the value stored at that key.
                return target_record.fields.iter().all(|field| {
                    field_view_compatible_inner(
                        index,
                        &field.r#type,
                        records,
                        unions,
                        depth + 1,
                        allow_callback_width,
                        allow_optional_widening,
                        active,
                    )
                });
            }
            if let (
                Type::Record {
                    shape_id: source_id,
                },
                Type::Record {
                    shape_id: target_id,
                },
            ) = (source, target)
                && let (Some(source_record), Some(target_record)) =
                    (records.get(*source_id), records.get(*target_id))
                && !source_record.tuple
                && !target_record.tuple
                && source_record.index_value.is_none()
                && target_record.index_value.is_none()
                && source_record
                    .fields
                    .iter()
                    .any(|field| field.name == "\0scriptc.call")
                    == target_record
                        .fields
                        .iter()
                        .any(|field| field.name == "\0scriptc.call")
            {
                let different_keys = source_record.fields.len() != target_record.fields.len()
                    || source_record.fields.iter().any(|field| {
                        !target_record
                            .fields
                            .iter()
                            .any(|other| same_field_name(&other.name, &field.name))
                    });
                if different_keys
                    && target_record.fields.iter().any(|target_field| {
                        source_record.fields.iter().any(|source_field| {
                            same_field_name(&source_field.name, &target_field.name)
                                && reaches_record(&source_field.r#type, *source_id, records, unions)
                                && reaches_record(&target_field.r#type, *target_id, records, unions)
                        })
                    })
                {
                    return false;
                }
                return target_record.fields.iter().all(|target_field| {
                    match source_record
                        .fields
                        .iter()
                        .find(|field| same_field_name(&field.name, &target_field.name))
                    {
                        Some(source_field) => field_view_compatible_inner(
                            &source_field.r#type,
                            &target_field.r#type,
                            records,
                            unions,
                            depth + 1,
                            allow_callback_width,
                            allow_optional_widening,
                            active,
                        ),
                        // A missing optional property is still absent in the
                        // shared backing object; writing through the new view
                        // must remain observable through the original reference.
                        None => {
                            optional(&target_field.r#type, unions)
                                && !contains_set(&target_field.r#type, records, unions)
                        }
                    }
                });
            }
            if super::record_equivalence::equivalent(source, target, records, unions) {
                return true;
            }
            if !matches!(source, Type::Union { .. }) && !matches!(target, Type::Union { .. }) {
                return false;
            }
            let source_arms = match source {
                Type::Union { union_id } => {
                    unions.get(*union_id).map(|union| union.arms.as_slice())
                }
                _ => None,
            };
            let target_arms = match target {
                Type::Union { union_id } => {
                    unions.get(*union_id).map(|union| union.arms.as_slice())
                }
                _ => None,
            };
            let source_arms = source_arms.unwrap_or(std::slice::from_ref(source));
            let target_arms = target_arms.unwrap_or(std::slice::from_ref(target));
            !source_arms.is_empty()
                && source_arms.iter().all(|source_arm| {
                    target_arms
                        .iter()
                        .filter(|target_arm| {
                            field_view_compatible_inner(
                                source_arm,
                                target_arm,
                                records,
                                unions,
                                depth + 1,
                                allow_callback_width,
                                allow_optional_widening,
                                active,
                            )
                        })
                        .count()
                        == 1
                })
        })();
        active.pop();
        compatible
    }
    fn field_view_compatible(
        source: &Type,
        target: &Type,
        records: &[Record],
        unions: &[Union],
        depth: usize,
        allow_callback_width: bool,
        allow_optional_widening: bool,
    ) -> bool {
        field_view_compatible_inner(
            source,
            target,
            records,
            unions,
            depth,
            allow_callback_width,
            allow_optional_widening,
            &mut Vec::new(),
        )
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
            if source.tuple {
                return None;
            }
            if let Some(source_index) = source.index_value.as_ref() {
                // Pure dictionaries use the same NativeValue-backed property
                // store regardless of their checker value view. Preserve the
                // object identity when a typed dictionary is passed through
                // Record<string, unknown> or a validated fixed-field view (and
                // validate typed reads lazily).
                if !source.fields.is_empty() {
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
                            && (target.fields.is_empty()
                                || allow_optional_widening
                                    && !target
                                        .fields
                                        .iter()
                                        .any(|field| field.name == "\0scriptc.call")
                                    && target.fields.iter().all(|field| {
                                        field_view_compatible(
                                            source_index,
                                            &field.r#type,
                                            records,
                                            unions,
                                            0,
                                            allow_callback_width,
                                            allow_optional_widening,
                                        )
                                    }))
                            && !contains_set(ty, records, unions)
                            && target.index_value.as_ref().is_none_or(|target_index| {
                                field_view_compatible(
                                    source_index,
                                    target_index,
                                    records,
                                    unions,
                                    0,
                                    allow_callback_width,
                                    allow_optional_widening,
                                )
                            }))
                        .then_some(to)
                    })
                    .collect::<Vec<_>>();
                return (choices.len() == 1).then(|| (from, choices[0]));
            }
            // Preserve the exact arm whenever one exists. A source record
            // can also satisfy a narrower width view, but that must not make an
            // otherwise exact union remapping ambiguous: keeping the original
            // shape is both the most precise choice and the only choice that
            // retains every statically known field.
            let exact = targets
                .iter()
                .enumerate()
                .filter_map(|(to, ty)| {
                    (ty == &Type::Record {
                        shape_id: *shape_id,
                    })
                        .then_some(to)
                })
                .collect::<Vec<_>>();
            if exact.len() == 1 {
                return Some((from, exact[0]));
            }
            if exact.len() > 1 {
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
                    let index_view = target.index_value.as_ref().is_none_or(|index| {
                        *index == Type::Dyn
                            || source.fields.iter().all(|field| {
                                field_view_compatible(
                                    &field.r#type,
                                    index,
                                    records,
                                    unions,
                                    0,
                                    allow_callback_width,
                                    allow_optional_widening,
                                )
                            })
                    });
                    (!target.tuple
                        && index_view
                        && source
                            .fields
                            .iter()
                            .any(|field| field.name == "\0scriptc.call")
                            == target
                                .fields
                                .iter()
                                .any(|field| field.name == "\0scriptc.call")
                        && target.fields.iter().all(|f| {
                            match source
                                .fields
                                .iter()
                                .find(|old| same_field_name(&old.name, &f.name))
                            {
                                Some(old) => field_view_compatible(
                                    &old.r#type,
                                    &f.r#type,
                                    records,
                                    unions,
                                    0,
                                    allow_callback_width,
                                    allow_optional_widening,
                                ),
                                // A view exposes an absent optional key without
                                // defining it or copying the shared property store.
                                None => {
                                    optional(&f.r#type, unions)
                                        && !contains_set(&f.r#type, records, unions)
                                }
                            }
                        }))
                    .then_some(to)
                })
                .collect::<Vec<_>>();
            if choices.len() == 1 {
                return Some((from, choices[0]));
            }
            if allow_callback_width && !choices.is_empty() {
                // A broader union can contain several safe views. Retain a
                // uniquely more precise view when it preserves more of the
                // source's declared field ABIs; equal scores stay ambiguous.
                let mut scored = choices
                    .iter()
                    .map(|to| {
                        let Type::Record { shape_id } = &targets[*to] else {
                            unreachable!()
                        };
                        let target = &records[*shape_id];
                        let present = if allow_optional_widening {
                            target
                                .fields
                                .iter()
                                .filter(|field| {
                                    source
                                        .fields
                                        .iter()
                                        .any(|old| same_field_name(&old.name, &field.name))
                                })
                                .count()
                        } else {
                            0
                        };
                        let exact = target
                            .fields
                            .iter()
                            .filter(|field| {
                                source.fields.iter().any(|old| {
                                    same_field_name(&old.name, &field.name)
                                        && old.r#type == field.r#type
                                })
                            })
                            .count();
                        // If two candidates preserve the same source fields,
                        // prefer the one that does not invent additional
                        // absent optional keys. That is the strictest checked
                        // view and avoids ambiguity between (for example) a
                        // scalar token and a wider token carrying optional
                        // end metadata.
                        let complete = usize::from(present == target.fields.len());
                        (*to, (present, exact, complete))
                    })
                    .collect::<Vec<_>>();
                scored.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
                if scored.len() == 1 || scored[0].1 > scored[1].1 {
                    return Some((from, scored[0].0));
                }
            }
            None
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
    fn checked_callable_view_discards_promise_fulfillment_for_void_result() {
        let callback = |result| Type::Func {
            rest: false,
            params: vec![],
            ret: Box::new(Type::Promise {
                inner: Box::new(result),
            }),
        };
        let records = vec![
            record(0, &[("write", callback(Type::Dyn))]),
            record(1, &[("write", callback(Type::Void))]),
        ];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 1 },
                &records,
                &[],
            ),
            Some(vec![(0, 0)])
        );
    }
    #[test]
    fn recursive_response_views_share_well_known_symbol_fields_across_checker_ids() {
        let method = |ret| Type::Func {
            rest: false,
            params: vec![],
            ret: Box::new(ret),
        };
        let records = vec![
            record(
                0,
                &[
                    (
                        "blob",
                        method(Type::Promise {
                            inner: Box::new(Type::Record { shape_id: 2 }),
                        }),
                    ),
                    ("clone", method(Type::Record { shape_id: 0 })),
                    ("\u{fdd0}@asyncIterator@1756", method(Type::Dyn)),
                ],
            ),
            record(
                1,
                &[
                    (
                        "blob",
                        method(Type::Promise {
                            inner: Box::new(Type::Record { shape_id: 3 }),
                        }),
                    ),
                    ("clone", method(Type::Record { shape_id: 1 })),
                    ("\u{fdd0}@asyncIterator@3459", method(Type::Dyn)),
                ],
            ),
            record(2, &[("size", Type::F64)]),
            record(3, &[("size", Type::F64)]),
        ];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 1 },
                &records,
                &[],
            ),
            Some(vec![(0, 0)])
        );
    }
    #[test]
    fn nested_dictionary_can_back_optional_flag_record() {
        let mut records = vec![
            record(0, &[("values", Type::Record { shape_id: 1 })]),
            record(1, &[]),
            record(2, &[("values", Type::Record { shape_id: 3 })]),
            record(3, &[("brief", Type::Union { union_id: 0 })]),
        ];
        records[1].index_value = Some(Type::Dyn);
        let unions = vec![Union {
            id: 0,
            arms: vec![Type::Bool, Type::Undefined],
        }];
        assert_eq!(
            dynamic_view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 2 },
                &records,
                &unions,
            ),
            Some(vec![(0, 0)])
        );
    }
    #[test]
    fn equivalent_recursive_json_dictionaries_share_a_view() {
        let mut records = vec![record(0, &[]), record(1, &[])];
        records[0].index_value = Some(Type::Union { union_id: 0 });
        records[1].index_value = Some(Type::Union { union_id: 1 });
        let json_arms = |record_id, union_id| {
            vec![
                Type::Array {
                    elem: Box::new(Type::Union { union_id }),
                },
                Type::Bool,
                Type::F64,
                Type::Null,
                Type::Record {
                    shape_id: record_id,
                },
                Type::String,
            ]
        };
        let unions = vec![
            Union {
                id: 0,
                arms: json_arms(0, 0),
            },
            Union {
                id: 1,
                arms: json_arms(1, 1),
            },
        ];
        assert_eq!(
            dynamic_view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 1 },
                &records,
                &unions,
            ),
            Some(vec![(0, 0)])
        );
    }
    #[test]
    fn nested_indexed_records_with_named_fields_keep_an_array_view() {
        let mut records = vec![
            record(0, &[("failures", Type::Union { union_id: 0 })]),
            record(1, &[("name", Type::String)]),
            record(2, &[("failures", Type::Union { union_id: 1 })]),
            record(3, &[("name", Type::String)]),
        ];
        records[3].index_value = Some(Type::Dyn);
        let unions = vec![
            Union {
                id: 0,
                arms: vec![
                    Type::Array {
                        elem: Box::new(Type::Record { shape_id: 1 }),
                    },
                    Type::Undefined,
                ],
            },
            Union {
                id: 1,
                arms: vec![
                    Type::Undefined,
                    Type::Array {
                        elem: Box::new(Type::Record { shape_id: 3 }),
                    },
                ],
            },
        ];
        assert_eq!(
            dynamic_view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 2 },
                &records,
                &unions
            ),
            Some(vec![(0, 0)])
        );
        records[3].fields[0].r#type = Type::F64;
        assert!(
            dynamic_view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 2 },
                &records,
                &unions
            )
            .is_none()
        );
    }
    #[test]
    fn typed_dictionary_admits_an_empty_record_view() {
        let mut records = vec![record(0, &[]), record(1, &[])];
        records[0].index_value = Some(Type::Bool);
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 1 },
                &records,
                &[],
            ),
            Some(vec![(0, 0)])
        );
    }
    #[test]
    fn dynamic_optional_widening_preserves_static_invariants() {
        let array = Type::Array {
            elem: Box::new(Type::String),
        };
        let records = vec![
            record(0, &[("aliases", array.clone()), ("kind", Type::String)]),
            record(
                1,
                &[
                    ("aliases", Type::Union { union_id: 0 }),
                    ("kind", Type::String),
                ],
            ),
        ];
        let unions = vec![Union {
            id: 0,
            arms: vec![array, Type::Undefined],
        }];
        let source = Type::Record { shape_id: 0 };
        let target = Type::Record { shape_id: 1 };
        assert_eq!(view_pairs(&source, &target, &records, &unions), None);
        assert_eq!(
            dynamic_view_pairs(&source, &target, &records, &unions),
            Some(vec![(0, 0)])
        );
    }

    #[test]
    fn checked_view_can_restore_a_required_field_after_internal_optional_merge() {
        let records = vec![
            record(0, &[("name", Type::Union { union_id: 0 })]),
            record(1, &[("name", Type::String)]),
        ];
        let unions = vec![Union {
            id: 0,
            arms: vec![Type::String, Type::Undefined],
        }];
        let source = Type::Record { shape_id: 0 };
        let target = Type::Record { shape_id: 1 };
        assert_eq!(view_pairs(&source, &target, &records, &unions), None);
        assert_eq!(
            dynamic_view_pairs(&source, &target, &records, &unions),
            Some(vec![(0, 0)])
        );
    }

    #[test]
    fn width_view_preserves_an_exact_typed_set_field() {
        let strings = Type::Set {
            elem: Box::new(Type::String),
        };
        let records = vec![
            record(
                0,
                &[
                    ("names", strings.clone()),
                    ("label", Type::String),
                    ("extra", Type::Bool),
                ],
            ),
            record(1, &[("names", strings), ("label", Type::String)]),
        ];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 1 },
                &records,
                &[],
            ),
            Some(vec![(0, 0)])
        );
    }

    #[test]
    fn erased_field_admits_a_checked_callable_view() {
        let callback = Type::Func {
            rest: false,
            params: vec![],
            ret: Box::new(Type::Dyn),
        };
        let records = vec![
            record(0, &[("toJSON", Type::Dyn)]),
            record(1, &[("toJSON", callback)]),
        ];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 1 },
                &records,
                &[],
            ),
            Some(vec![(0, 0)])
        );
    }

    #[test]
    fn closed_record_admits_same_fields_with_dynamic_index_view() {
        let mut records = vec![
            record(0, &[("schema", Type::F64), ("profile", Type::Dyn)]),
            record(1, &[("schema", Type::F64), ("profile", Type::Dyn)]),
        ];
        records[1].index_value = Some(Type::Dyn);
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 1 },
                &records,
                &[],
            ),
            Some(vec![(0, 0)])
        );
    }
    #[test]
    fn closed_record_admits_checked_optional_dictionary_union_view() {
        let mut records = vec![
            record(
                0,
                &[
                    ("DEBIAN_FRONTEND", Type::String),
                    ("NODE_ENV", Type::Union { union_id: 0 }),
                ],
            ),
            record(1, &[]),
        ];
        records[1].index_value = Some(Type::Union { union_id: 0 });
        let unions = vec![
            Union {
                id: 0,
                arms: vec![Type::String, Type::Undefined],
            },
            Union {
                id: 1,
                arms: vec![Type::Record { shape_id: 1 }, Type::Undefined],
            },
        ];
        let source = Type::Record { shape_id: 0 };
        let target = Type::Union { union_id: 1 };
        assert_eq!(view_pairs(&source, &target, &records, &unions), None);
        assert_eq!(
            dynamic_view_pairs(&source, &target, &records, &unions),
            Some(vec![(0, 0)])
        );
    }
    #[test]
    fn dynamic_union_prefers_the_view_with_more_present_fields() {
        let callback = |ret| Type::Func {
            params: vec![Type::String],
            ret: Box::new(ret),
            rest: false,
        };
        let records = vec![
            record(
                0,
                &[("kind", Type::String), ("coerce", callback(Type::String))],
            ),
            record(
                1,
                &[
                    ("kind", Type::String),
                    ("aliases", Type::Union { union_id: 0 }),
                ],
            ),
            record(
                2,
                &[
                    ("kind", Type::String),
                    ("aliases", Type::Union { union_id: 0 }),
                    ("coerce", callback(Type::Dyn)),
                ],
            ),
        ];
        let unions = vec![
            Union {
                id: 0,
                arms: vec![
                    Type::Array {
                        elem: Box::new(Type::String),
                    },
                    Type::Undefined,
                ],
            },
            Union {
                id: 1,
                arms: vec![Type::Record { shape_id: 1 }, Type::Record { shape_id: 2 }],
            },
        ];
        assert_eq!(
            dynamic_view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Union { union_id: 1 },
                &records,
                &unions
            ),
            Some(vec![(0, 1)])
        );
    }
    #[test]
    fn dynamic_union_prefers_complete_width_over_missing_optional_fields() {
        let records = vec![
            record(
                0,
                &[
                    ("indent", Type::F64),
                    ("offset", Type::F64),
                    ("source", Type::String),
                    ("type", Type::Dyn),
                ],
            ),
            record(
                1,
                &[
                    ("indent", Type::F64),
                    ("offset", Type::F64),
                    ("source", Type::String),
                    ("type", Type::String),
                ],
            ),
            record(
                2,
                &[
                    ("end", Type::Union { union_id: 0 }),
                    ("indent", Type::F64),
                    ("offset", Type::F64),
                    ("source", Type::String),
                    ("type", Type::String),
                ],
            ),
        ];
        let unions = vec![
            Union {
                id: 0,
                arms: vec![Type::String, Type::Undefined],
            },
            Union {
                id: 1,
                arms: vec![Type::Record { shape_id: 1 }, Type::Record { shape_id: 2 }],
            },
        ];
        assert_eq!(
            dynamic_view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Union { union_id: 1 },
                &records,
                &unions,
            ),
            Some(vec![(0, 0)])
        );
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
    fn callback_record_parameters_are_checked_contravariantly() {
        let callback = |shape_id| Type::Func {
            params: vec![Type::Record { shape_id }],
            ret: Box::new(Type::String),
            rest: false,
        };
        let records = vec![
            record(0, &[("source", Type::String)]),
            record(1, &[("source", Type::String), ("value", Type::String)]),
            record(2, &[("callback", callback(0))]),
            record(3, &[("callback", callback(1))]),
            record(4, &[("callback", callback(0))]),
        ];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 2 },
                &Type::Record { shape_id: 3 },
                &records,
                &[]
            ),
            Some(vec![(0, 0)])
        );
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 3 },
                &Type::Record { shape_id: 2 },
                &records,
                &[]
            ),
            None
        );
        let unions = vec![Union {
            id: 0,
            arms: vec![Type::Record { shape_id: 3 }, Type::Record { shape_id: 4 }],
        }];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 2 },
                &Type::Union { union_id: 0 },
                &records,
                &unions
            ),
            Some(vec![(0, 1)])
        );
    }
    #[test]
    fn callback_width_fallback_keeps_existing_precise_union_arm() {
        let function = |params: Vec<Type>, ret: Type| Type::Func {
            params,
            ret: Box::new(ret),
            rest: false,
        };
        let identify = function(vec![Type::Dyn], Type::Bool);
        let records = vec![
            record(0, &[("source", Type::Dyn)]),
            record(1, &[("source", Type::Dyn), ("value", Type::Dyn)]),
            record(
                2,
                &[
                    ("format", Type::Dyn),
                    ("minFractionDigits", Type::Dyn),
                    ("tag", Type::Dyn),
                    ("value", Type::Dyn),
                ],
            ),
            record(3, &[("value", Type::Dyn)]),
            record(
                4,
                &[
                    ("createNode", Type::Dyn),
                    ("default", Type::Bool),
                    ("identify", identify.clone()),
                    ("resolve", Type::Dyn),
                    (
                        "stringify",
                        function(vec![Type::Record { shape_id: 0 }, Type::Dyn], Type::Dyn),
                    ),
                    ("tag", Type::String),
                    ("test", Type::Regex),
                ],
            ),
            record(
                5,
                &[
                    ("default", Type::Bool),
                    ("identify", identify.clone()),
                    ("resolve", Type::Dyn),
                    (
                        "stringify",
                        function(vec![Type::Record { shape_id: 1 }, Type::Dyn], Type::Dyn),
                    ),
                    ("tag", Type::String),
                    ("test", Type::Regex),
                ],
            ),
            record(
                6,
                &[
                    ("default", Type::Bool),
                    ("identify", identify.clone()),
                    ("resolve", function(vec![Type::Dyn], Type::F64)),
                    (
                        "stringify",
                        function(vec![Type::Record { shape_id: 2 }], Type::String),
                    ),
                    ("tag", Type::String),
                    ("test", Type::Regex),
                ],
            ),
            record(
                7,
                &[
                    ("default", Type::Bool),
                    ("identify", identify.clone()),
                    ("resolve", Type::Dyn),
                    (
                        "stringify",
                        function(vec![Type::Record { shape_id: 2 }], Type::String),
                    ),
                    ("tag", Type::String),
                    ("test", Type::Regex),
                ],
            ),
            record(
                8,
                &[
                    ("default", Type::Bool),
                    ("identify", identify),
                    ("resolve", function(vec![Type::Dyn], Type::Dyn)),
                    (
                        "stringify",
                        function(vec![Type::Record { shape_id: 3 }], Type::Dyn),
                    ),
                    ("tag", Type::String),
                    ("test", Type::Regex),
                ],
            ),
        ];
        let unions = vec![Union {
            id: 0,
            arms: vec![
                Type::Record { shape_id: 5 },
                Type::Record { shape_id: 7 },
                Type::Record { shape_id: 8 },
            ],
        }];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 4 },
                &Type::Union { union_id: 0 },
                &records,
                &unions
            ),
            Some(vec![(0, 0)])
        );
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 6 },
                &Type::Union { union_id: 0 },
                &records,
                &unions
            ),
            Some(vec![(0, 1)])
        );
    }
    #[test]
    fn callback_extra_arguments_prefer_the_unique_closest_view() {
        let function = |params: Vec<Type>, ret: Type| Type::Func {
            params,
            ret: Box::new(ret),
            rest: false,
        };
        let source = vec![
            ("format", Type::String),
            ("resolve", function(vec![Type::Dyn], Type::F64)),
            ("stringify", function(vec![Type::Dyn], Type::String)),
        ];
        let broad = vec![
            ("format", Type::String),
            (
                "resolve",
                function(
                    vec![Type::Dyn, Type::Dyn, Type::Dyn],
                    Type::Union { union_id: 0 },
                ),
            ),
            ("stringify", function(vec![Type::Dyn], Type::Dyn)),
        ];
        let precise = vec![
            ("format", Type::String),
            (
                "resolve",
                function(vec![Type::Dyn, Type::Dyn, Type::Dyn], Type::Dyn),
            ),
            ("stringify", function(vec![Type::Dyn], Type::String)),
        ];
        let records = vec![
            record(0, &source),
            record(1, &broad),
            record(2, &precise),
            record(3, &precise),
        ];
        let unions = vec![
            Union {
                id: 0,
                arms: vec![Type::Bigint, Type::F64],
            },
            Union {
                id: 1,
                arms: vec![Type::Record { shape_id: 1 }, Type::Record { shape_id: 2 }],
            },
            Union {
                id: 2,
                arms: vec![Type::Record { shape_id: 2 }, Type::Record { shape_id: 3 }],
            },
        ];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Union { union_id: 1 },
                &records,
                &unions
            ),
            Some(vec![(0, 1)])
        );
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Union { union_id: 2 },
                &records,
                &unions
            ),
            None
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
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Union { union_id: 0 },
                &records,
                &unions
            ),
            Some(vec![(0, 0)])
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
    fn dynamic_fields_have_checked_narrow_views_and_concrete_fields_can_be_erased() {
        let records = vec![
            record(0, &[("width", Type::Dyn), ("height", Type::Dyn)]),
            record(1, &[("width", Type::F64), ("height", Type::F64)]),
            record(2, &[("width", Type::Dyn)]),
            record(3, &[("width", Type::Union { union_id: 0 })]),
        ];
        let unions = vec![Union {
            id: 0,
            arms: vec![Type::F64, Type::Undefined],
        }];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 1 },
                &records,
                &[],
            ),
            Some(vec![(0, 0)])
        );
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 1 },
                &Type::Record { shape_id: 0 },
                &records,
                &[],
            ),
            Some(vec![(0, 0)])
        );
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 2 },
                &Type::Record { shape_id: 3 },
                &records,
                &unions,
            ),
            Some(vec![(0, 0)])
        );
    }

    #[test]
    fn nested_closed_records_share_compatible_views() {
        let records = vec![
            record(0, &[("key", Type::String), ("extra", Type::Bool)]),
            record(1, &[("key", Type::String)]),
            record(2, &[("layers", Type::Record { shape_id: 0 })]),
            record(3, &[("layers", Type::Record { shape_id: 1 })]),
        ];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 2 },
                &Type::Record { shape_id: 3 },
                &records,
                &[],
            ),
            Some(vec![(0, 0)])
        );
    }
    #[test]
    fn callable_records_share_views_across_promise_payload_projections() {
        let source_call = Type::Func {
            rest: false,
            params: vec![],
            ret: Box::new(Type::Promise {
                inner: Box::new(Type::Record { shape_id: 0 }),
            }),
        };
        let target_call = Type::Func {
            rest: false,
            params: vec![],
            ret: Box::new(Type::Promise {
                inner: Box::new(Type::Record { shape_id: 1 }),
            }),
        };
        let records = vec![
            record(0, &[("value", Type::String), ("extra", Type::Bool)]),
            record(1, &[("value", Type::String)]),
            record(2, &[("\0scriptc.call", source_call)]),
            record(3, &[("\0scriptc.call", target_call)]),
        ];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 2 },
                &Type::Record { shape_id: 3 },
                &records,
                &[],
            ),
            Some(vec![(0, 0)])
        );
    }
    #[test]
    fn recursive_callable_payload_records_share_coinductive_views() {
        let slice = |shape_id| Type::Func {
            rest: false,
            params: vec![],
            ret: Box::new(Type::Record { shape_id }),
        };
        let blob = |shape_id| Type::Func {
            rest: false,
            params: vec![],
            ret: Box::new(Type::Promise {
                inner: Box::new(Type::Record { shape_id }),
            }),
        };
        let records = vec![
            record(0, &[("size", Type::F64), ("slice", slice(0))]),
            record(1, &[("size", Type::F64), ("slice", slice(1))]),
            record(2, &[("blob", blob(0))]),
            record(3, &[("blob", blob(1))]),
        ];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 2 },
                &Type::Record { shape_id: 3 },
                &records,
                &[],
            ),
            Some(vec![(0, 0)])
        );
    }
    #[test]
    fn field_views_allow_unambiguous_union_widening_but_not_narrowing() {
        let records = vec![
            record(0, &[("protocol", Type::String)]),
            record(1, &[("protocol", Type::Union { union_id: 0 })]),
        ];
        let unions = vec![Union {
            id: 0,
            arms: vec![Type::String, Type::Bool],
        }];
        assert_eq!(
            view_pairs(
                &Type::Record { shape_id: 0 },
                &Type::Record { shape_id: 1 },
                &records,
                &unions,
            ),
            Some(vec![(0, 0)])
        );
        assert!(
            view_pairs(
                &Type::Record { shape_id: 1 },
                &Type::Record { shape_id: 0 },
                &records,
                &unions,
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
