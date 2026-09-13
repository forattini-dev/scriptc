//! Native Date object identity. Calendar operations continue using the shared
//! TimeClip/calendar primitives, while aliases retain the same internal slot.
use std::{cell::Cell, rc::Rc};
use crate::{JsString, JsonValue, JsonWriter, Tracer};

#[derive(Clone, Debug)]
pub struct JsDate(Rc<Cell<f64>>);

impl PartialEq for JsDate {
    fn eq(&self, other: &Self) -> bool { Rc::ptr_eq(&self.0, &other.0) }
}
impl Eq for JsDate {}
impl crate::ArrayElement for JsDate {}
impl crate::JsonDecode for JsDate {
    fn decode_json(_: &crate::JsonNode, path: &str) -> Result<Self, String> {
        Err(format!("expected a Date object at {path}, received JSON data"))
    }
}
impl crate::Trace for JsDate { fn trace(&self, _: &mut Tracer<'_>) {} }
impl crate::HeapValue for JsDate { fn trace_value(&self, _: &mut Tracer<'_>) {} }

pub fn date_value_new(milliseconds: f64) -> JsDate {
    JsDate(Rc::new(Cell::new(crate::date_new_ms(milliseconds))))
}
pub fn date_value_time(value: &JsDate) -> f64 { value.0.get() }
pub fn date_value_identity(value: &JsDate) -> usize { Rc::as_ptr(&value.0) as usize }
pub fn date_value_copy(value: &JsDate) -> JsDate { date_value_new(date_value_time(value)) }
pub fn date_value_inspect(value: &JsDate) -> JsString {
    let time = date_value_time(value);
    if time.is_nan() { crate::string("Invalid Date") } else { crate::date_to_iso(time) }
}
/// The existing Date surface intentionally excludes locale/string formatters.
/// Keep this boundary explicit when an unknown now contains a Date object.
pub fn date_value_to_string(_: &JsDate) -> JsString {
    crate::throw_type_error("native Date string coercion is not supported yet; use toISOString()".to_owned())
}
impl JsonValue for JsDate {
    fn write_json(&self, writer: &mut JsonWriter) {
        let time = date_value_time(self);
        if time.is_nan() { writer.write_null(); } else { crate::date_to_iso(time).write_json(writer); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_share_identity_but_copies_do_not() {
        let date = date_value_new(1.9);
        let alias = date.clone();
        let copy = date_value_copy(&date);
        assert_eq!(date, alias);
        assert_ne!(date, copy);
        assert_eq!(date_value_time(&copy), 1.0);
        assert_eq!(date_value_identity(&date), date_value_identity(&alias));
    }
    #[test]
    fn invalid_objects_still_have_identity_and_serialize_to_null() {
        let date = date_value_new(f64::INFINITY);
        assert_eq!(date, date.clone());
        assert_ne!(date, date_value_copy(&date));
        assert_eq!(crate::json_stringify(&date).as_ref(), "null");
        assert_eq!(date_value_inspect(&date).as_ref(), "Invalid Date");
    }
}
