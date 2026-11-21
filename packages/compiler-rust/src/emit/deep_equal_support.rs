fn native_deep_strict_equal(left: NativeValue, right: NativeValue) -> bool {
    native_deep_strict_equal_inner(&left, &right, &mut Vec::new())
}

fn native_deep_pair_seen(
    left: &NativeValue,
    right: &NativeValue,
    seen: &[(NativeValue, NativeValue)],
) -> bool {
    seen.iter()
        .any(|(past_left, past_right)| native_value_eq(left, past_left) && native_value_eq(right, past_right))
}

fn native_deep_strict_equal_inner(
    left: &NativeValue,
    right: &NativeValue,
    seen: &mut Vec<(NativeValue, NativeValue)>,
) -> bool {
    if native_value_eq(left, right) {
        return true;
    }
    match (left, right) {
        (NativeValue::Number(left), NativeValue::Number(right)) => {
            return left == right || left.is_nan() && right.is_nan();
        }
        (NativeValue::ArrayBuffer(left), NativeValue::ArrayBuffer(right)) => {
            return runtime::bytes_deep_equals(left, right);
        }
        (NativeValue::Date(left), NativeValue::Date(right)) => {
            return runtime::date_value_time(left) == runtime::date_value_time(right);
        }
        _ => {}
    }

    let left_array = native_value_is_array(left);
    let right_array = native_value_is_array(right);
    if left_array || right_array {
        if !left_array || !right_array {
            return false;
        }
        if native_deep_pair_seen(left, right, seen) {
            return true;
        }
        let left_len = native_array_map_length(left) as usize;
        if left_len != native_array_map_length(right) as usize {
            return false;
        }
        seen.push((left.clone(), right.clone()));
        for index in 0..left_len {
            let left_item = native_array_map_slot(left, index as f64);
            let right_item = native_array_map_slot(right, index as f64);
            let equal = match (left_item, right_item) {
                (None, None) => true,
                (Some(left_item), Some(right_item)) => {
                    native_deep_strict_equal_inner(&left_item, &right_item, seen)
                }
                _ => false,
            };
            if !equal {
                seen.pop();
                return false;
            }
        }
        seen.pop();
        return true;
    }

    let left_prototype = native_value_plain_record_prototype(left);
    let right_prototype = native_value_plain_record_prototype(right);
    if left_prototype.is_some() || right_prototype.is_some() {
        if left_prototype != right_prototype {
            return false;
        }
        if native_deep_pair_seen(left, right, seen) {
            return true;
        }
        let mut left_keys = native_value_own_keys(left);
        let mut right_keys = native_value_own_keys(right);
        left_keys.retain(|key| native_getter_enumerable(left, key));
        right_keys.retain(|key| native_getter_enumerable(right, key));
        left_keys.sort();
        right_keys.sort();
        if left_keys != right_keys {
            return false;
        }
        seen.push((left.clone(), right.clone()));
        for key in left_keys {
            let left_field = native_value_get(left.clone(), key.clone());
            let right_field = native_value_get(right.clone(), key);
            if !native_deep_strict_equal_inner(&left_field, &right_field, seen) {
                seen.pop();
                return false;
            }
        }
        seen.pop();
        return true;
    }

    false
}
