/// Storage adapters report descriptor outcomes; language mode controls failure.
pub enum NativeDeleteResult {
    Deleted,
    NonConfigurable(&'static str),
    Nullish,
    Unsupported(&'static str),
}

pub trait NativeDeleteValue {
    fn delete_own_property(&self, key: &JsString) -> NativeDeleteResult;
}

pub fn native_delete_property<V: NativeDeleteValue>(
    value: &V,
    key: &JsString,
    strict: bool,
) -> bool {
    match value.delete_own_property(key) {
        NativeDeleteResult::Deleted => true,
        NativeDeleteResult::NonConfigurable(receiver) => {
            if strict {
                throw_type_error(format!("Cannot delete property '{key}' of {receiver}"));
            }
            false
        }
        NativeDeleteResult::Nullish => {
            throw_type_error("Cannot convert undefined or null to object".into())
        }
        NativeDeleteResult::Unsupported(kind) => throw_type_error(format!(
            "scriptc: native property deletion on {kind} is not ported"
        )),
    }
}

fn native_delete_index(key: &JsString) -> Option<u32> {
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && *key == index.to_string()).then_some(index)
}

pub fn native_string_delete(text: &JsString, key: &JsString) -> NativeDeleteResult {
    if *key == "length"
        || native_delete_index(key)
            .is_some_and(|index| (index as usize) < text.encode_utf16().count())
    {
        NativeDeleteResult::NonConfigurable("[object String]")
    } else {
        NativeDeleteResult::Deleted
    }
}

pub fn native_array_delete<T: ArrayElement>(
    array: &JsArray<T>,
    key: &JsString,
) -> NativeDeleteResult {
    if *key == "length" {
        return NativeDeleteResult::NonConfigurable("[object Array]");
    }
    if let Some(index) = native_delete_index(key) {
        array_delete(array, f64::from(index));
    } else {
        if array_view(array).is_some() {
            return NativeDeleteResult::Unsupported("an array property view");
        }
        array.with_mut(|data| {
            if let Some(properties) = &mut data.properties {
                properties.retain(|(name, _)| name != key);
            }
        });
    }
    NativeDeleteResult::Deleted
}

#[cfg(test)]
mod native_delete_tests {
    use super::*;

    #[test]
    fn array_deletion_retains_length_and_distinguishes_holes_from_undefined() {
        let array = array_new(vec![1.0, 2.0]);
        array_set_undefined(&array, 1.0);
        array_property_set(&array, string("01"), 7.0);
        assert!(matches!(
            native_array_delete(&array, &string("0")),
            NativeDeleteResult::Deleted
        ));
        assert_eq!(array_len(&array), 2.0);
        assert_eq!(array_state(&array, 0.0), 0.0);
        assert_eq!(array_state(&array, 1.0), 2.0);
        assert!(matches!(
            native_array_delete(&array, &string("01")),
            NativeDeleteResult::Deleted
        ));
        assert_eq!(array_property_get(&array, &string("01")), None);
        assert!(matches!(
            native_array_delete(&array, &string("length")),
            NativeDeleteResult::NonConfigurable(_)
        ));
        native_array_delete(&array, &string("4294967294"));
        assert_eq!(array_len(&array), 2.0);
    }

    #[test]
    fn string_descriptors_use_utf16_and_canonical_indices() {
        let text = string("\u{1f600}");
        for key in ["0", "1", "length"] {
            assert!(matches!(
                native_string_delete(&text, &string(key)),
                NativeDeleteResult::NonConfigurable(_)
            ));
        }
        for key in ["2", "01", "-0", "4294967295"] {
            assert!(matches!(
                native_string_delete(&text, &string(key)),
                NativeDeleteResult::Deleted
            ));
        }
    }
}
