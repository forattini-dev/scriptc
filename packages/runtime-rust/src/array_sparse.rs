impl<T: ArrayElement> ArrayData<T> {
    fn stored_value(&self, index: usize) -> Option<&T> {
        self.elements
            .get(index)
            .or_else(|| self.sparse.as_ref()?.tail_values.get(&index))
    }
}

/// Read a typed payload. Consumers that observe absence consult slot state first.
pub fn array_get<T: ArrayElement>(array: &JsArray<T>, index: f64) -> T {
    // Numeric non-index keys are ordinary properties, including negatives.
    if (!(0.0..f64::from(u32::MAX)).contains(&index) || index.fract() != 0.0)
        && let Some(value) = array_property_get(array, &number_to_string(index))
    {
        return value;
    }
    let index = array_index(index, false, array_len(array) as usize);
    array.with(|data| match &data.view {
        Some(view) => view.get(index as f64),
        None => {
            if data.slot_state(index) != ARRAY_VALUE {
                throw_type_error_code(format!("reading the missing array element {index} as a non-optional value is not supported yet"), "SC3001");
            }
            data.stored_value(index).expect("scriptc: present array payload").clone()
        }
    })
}

pub fn array_next_present<T: ArrayElement>(array: &JsArray<T>, start: f64) -> f64 {
    let len = array_len(array);
    if start.is_nan() || start >= len {
        return len;
    }
    let first = if start > 0.0 { start.ceil() } else { 0.0 };
    array.with(|data| {
        let Some(sparse) = data.sparse.as_ref().filter(|_| data.view.is_none()) else {
            return first;
        };
        let mut index = first as usize;
        while index < sparse.states.len() && data.slot_state(index) == ARRAY_HOLE {
            index += 1;
        }
        if index < sparse.states.len() {
            return index as f64;
        }
        let undefined = sparse.tail_undefined.range(index..).next().copied();
        let value = sparse
            .tail_values
            .range(index..)
            .next()
            .map(|(index, _)| *index);
        undefined
            .into_iter()
            .chain(value)
            .min()
            .map_or(len, |index| index as f64)
    })
}

pub fn array_set<T: ArrayElement>(array: &JsArray<T>, index: f64, value: T) {
    if !(0.0..f64::from(u32::MAX)).contains(&index) || index.fract() != 0.0 {
        array_property_set(array, number_to_string(index), value);
        return;
    }
    if let Some(view) = array_view(array) {
        view.set(index, value);
        return;
    }
    let at = array_canonical_index(index);
    array.with_mut(|data| {
        let stored = data.elements.len();
        if data.sparse.is_none() && at <= stored {
            if at == stored {
                data.elements.push(value)
            } else {
                data.elements[at] = value
            }
            return;
        }
        if at < stored {
            data.elements[at] = value;
            if let Some(sparse) = data.sparse.as_mut() {
                sparse.states[at] = ARRAY_VALUE;
            }
        } else {
            let length = data.logical_len();
            data.sparse_mut();
            let sparse = data
                .sparse
                .as_mut()
                .expect("scriptc: sparse array bookkeeping");
            if at - stored > ARRAY_DENSE_LIMIT {
                sparse.tail_undefined.remove(&at);
                sparse.tail_values.insert(at, value);
                sparse.length = length.max(at + 1);
                return;
            }
            for gap in stored..at {
                if let Some(existing) = sparse.tail_values.remove(&gap) {
                    data.elements.push(existing);
                    sparse.states.push(ARRAY_VALUE);
                } else {
                    data.elements.push(value.clone());
                    sparse.states.push(if sparse.tail_undefined.remove(&gap) {
                        ARRAY_UNDEFINED
                    } else {
                        ARRAY_HOLE
                    });
                }
            }
            data.elements.push(value);
            sparse.tail_undefined.remove(&at);
            sparse.tail_values.remove(&at);
            sparse.states.push(ARRAY_VALUE);
            sparse.length = length.max(at + 1);
        }
        data.normalize_sparse();
    });
}

pub fn array_slice<T: ArrayElement>(array: &JsArray<T>, start: f64, end: f64) -> JsArray<T> {
    array.with(|data| {
        let Some(sparse) = data.sparse.as_ref().filter(|_| data.view.is_none()) else {
            let elements = data.elements();
            let start = array_relative_index(start, elements.len());
            let end = array_relative_index(end, elements.len()).max(start);
            return array_new(elements[start..end].to_vec());
        };
        let start = array_relative_index(start, sparse.length);
        let end = array_relative_index(end, sparse.length).max(start);
        let stored_end = end.min(data.elements.len());
        let (elements, states) = if start < stored_end {
            (
                data.elements[start..stored_end].to_vec(),
                sparse.states[start..stored_end].to_vec(),
            )
        } else {
            (Vec::new(), Vec::new())
        };
        let tail_undefined = sparse
            .tail_undefined
            .range(start.max(data.elements.len())..end)
            .map(|index| index - start)
            .collect();
        let tail_values = sparse
            .tail_values
            .range(start.max(data.elements.len())..end)
            .map(|(index, value)| (index - start, value.clone()))
            .collect();
        let mut copy = ArrayData {
            elements,
            auxiliary: None,
            properties: None,
            view: None,
            sparse: Some(Box::new(ArraySparse {
                length: end - start,
                states,
                tail_undefined,
                tail_values,
            })),
        };
        copy.normalize_sparse();
        Gc::new(copy)
    })
}

/// A checked-dynamic undefined needle also matches holes and explicit undefined.
pub fn array_includes_missing_by<T: ArrayElement>(
    array: &JsArray<T>,
    needle: &T,
    undefined: bool,
    equal: impl Fn(&T, &T) -> bool,
) -> bool {
    if undefined
        && array.with(|data| {
            data.view.is_none()
                && data.sparse.as_ref().is_some_and(|sparse| {
                    sparse.states.contains(&ARRAY_UNDEFINED)
                        || sparse.states.contains(&ARRAY_HOLE)
                        || sparse.length > sparse.states.len() + sparse.tail_values.len()
                })
        })
    {
        return true;
    }
    array_includes_by(array, needle, equal)
}

/// Concat preserves holes, unlike iterator-based push/spread.
pub fn array_concat_from<T: ArrayElement>(array: &JsArray<T>, source: &JsArray<T>) -> f64 {
    let (length, slots) = source.with(|data| {
        if let Some(view) = &data.view {
            return (
                view.len(),
                (0..view.len() as usize)
                    .map(|index| (index, Some(view.get(index as f64))))
                    .collect::<Vec<_>>(),
            );
        }
        let mut slots = (0..data.elements.len())
            .filter_map(|index| match data.slot_state(index) {
                ARRAY_VALUE => Some((index, Some(data.elements[index].clone()))),
                ARRAY_UNDEFINED => Some((index, None)),
                _ => None,
            })
            .collect::<Vec<_>>();
        if let Some(sparse) = &data.sparse {
            slots.extend(sparse.tail_undefined.iter().map(|index| (*index, None)));
            slots.extend(
                sparse
                    .tail_values
                    .iter()
                    .map(|(index, value)| (*index, Some(value.clone()))),
            );
        }
        (data.logical_len() as f64, slots)
    });
    let offset = array_len(array);
    if offset + length > f64::from(u32::MAX) {
        throw_range_error("Invalid array length".to_owned());
    }
    for (index, value) in slots {
        match value {
            Some(value) => array_set(array, offset + index as f64, value),
            None => array_set_undefined(array, offset + index as f64),
        }
    }
    array_set_length(array, offset + length);
    offset + length
}
