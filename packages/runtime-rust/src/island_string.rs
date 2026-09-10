/// Boa accepts UTF-16 directly. Preserve lone units when a native value enters
/// the island; ordinary text uses its existing UTF-8 construction path.
fn island_string<S: JsStringSource + ?Sized>(value: &S) -> boa_engine::JsString {
    match value.well_formed_utf8() {
        Some(text) => boa_engine::JsString::from(text),
        None => boa_engine::JsString::from(value.utf16_units().collect::<Vec<_>>().as_slice()),
    }
}
