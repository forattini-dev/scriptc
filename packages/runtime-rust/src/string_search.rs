fn clamp_string_position(value: &JsString, position: f64) -> f64 {
    if position.is_nan() {
        0.0
    } else {
        position.trunc().clamp(0.0, string_len(value))
    }
}

pub fn string_includes(value: &JsString, search: &JsString, from_index: f64) -> bool {
    string_index_of(value, search, from_index) >= 0.0
}

pub fn string_starts_with(value: &JsString, search: &JsString, position: f64) -> bool {
    let start = clamp_string_position(value, position);
    string_index_of(value, search, start) == start
}

pub fn string_ends_with(value: &JsString, search: &JsString, end_position: f64) -> bool {
    let end = clamp_string_position(value, end_position);
    let start = end - string_len(search);
    start >= 0.0 && string_last_index_of(value, search, start) == start
}
