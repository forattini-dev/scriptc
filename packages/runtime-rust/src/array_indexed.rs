// Optional reads used by scalar IR intrinsics. Non-index numeric keys are
// ordinary properties (including NaN, infinities and 2^32 - 1).
fn array_indexed_value<T: ArrayElement>(array: &JsArray<T>, index: f64) -> Option<T> {
    if (0.0..f64::from(u32::MAX)).contains(&index) && index.fract() == 0.0 {
        (array_state(array, index) == f64::from(ARRAY_VALUE)).then(|| array_get(array, index))
    } else {
        array_property_get(array, &number_to_string(index))
    }
}

pub fn array_get_number(array: &JsArray<f64>, index: f64) -> f64 {
    array_indexed_value(array, index).unwrap_or(f64::NAN)
}

pub fn array_index_equal_by<T: ArrayElement>(
    left: &JsArray<T>,
    left_index: f64,
    right: &JsArray<T>,
    right_index: f64,
    equal: impl FnOnce(&T, &T) -> bool,
) -> bool {
    match (
        array_indexed_value(left, left_index),
        array_indexed_value(right, right_index),
    ) {
        (Some(left), Some(right)) => equal(&left, &right),
        (None, None) => true,
        _ => false,
    }
}
