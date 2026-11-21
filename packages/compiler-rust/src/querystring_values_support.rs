impl runtime::QuerystringDyn for NativeValue {
    fn querystring_object_entries(&self) -> Option<Vec<(runtime::JsString, Self)>> {
        if !matches!(self, Self::Record(..) | Self::Object(..)) {
            return None;
        }
        let mut keys = native_value_own_keys(self);
        keys.retain(|key| native_getter_enumerable(self, key));
        keys.sort_by_key(|key| {
            key.parse::<u32>()
                .ok()
                .filter(|index| *index != u32::MAX && *key == index.to_string())
                .map(|index| (0, index))
                .unwrap_or((1, 0))
        });
        Some(
            keys.into_iter()
                .map(|key| {
                    let value = native_value_get(self.clone(), key.clone());
                    (key, value)
                })
                .collect(),
        )
    }

    fn querystring_array_values(&self) -> Option<Vec<Self>> {
        native_querystring_array_values(self)
    }

    fn querystring_scalar(&self) -> runtime::JsString {
        match self {
            Self::String(value) => value.clone(),
            Self::Number(value) if value.is_finite() => {
                runtime::JsString::from(js_string_number(*value))
            }
            Self::BigInt(value) => runtime::bigint_to_string(value),
            Self::Boolean(value) => runtime::JsString::from(value.to_string()),
            _ => runtime::empty_string(),
        }
    }
}
