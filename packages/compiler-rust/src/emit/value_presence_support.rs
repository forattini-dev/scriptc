// Ordinary data records have the unmodified intrinsic Object.prototype.
// Prototype setters and symbol slots remain fenced at their write sites.
// rawJSON is handled separately: its object has a null prototype.
fn native_object_prototype_has_key(key: &runtime::JsString) -> bool {
    matches!(key.well_formed_utf8(), Some(
        "constructor" | "__defineGetter__" | "__defineSetter__" | "hasOwnProperty"
        | "__lookupGetter__" | "__lookupSetter__" | "isPrototypeOf"
        | "propertyIsEnumerable" | "toString" | "valueOf" | "__proto__" | "toLocaleString"
    ))
}
