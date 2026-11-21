// Accessor metadata is an ephemeron of the existing property store: it keeps
// getter closures alive while the owner is alive, including through cycles,
// without replacing the original object or function identity.
#[derive(Clone, Default)]
struct NativeGetters {
    properties: runtime::OrdinaryPropertyTable<NativeValue>,
    frozen: bool,
}
thread_local! { static NATIVE_HAS_GETTERS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
impl runtime::HeapValue for NativeGetters {
    fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) {
        self.properties
            .trace_values(|value| value.trace_native(tracer));
    }
}
fn native_getter_store(value: &NativeValue) -> Option<runtime::Gc<NativeRecordData>> {
    match value {
        NativeValue::Object(object) | NativeValue::Record(_, object) => Some(object.clone()),
        _ => native_function_properties(value),
    }
}
fn native_getter_registry(store: &runtime::Gc<NativeRecordData>) -> NativeGetters {
    let key = runtime::WeakKey::new(store);
    runtime::weak_map_get::<NativeGetters>(&key, &key).unwrap_or_default()
}
fn native_getter_registry_key(value: &NativeValue) -> Option<runtime::WeakKey> {
    native_getter_store(value)
        .map(|store| runtime::WeakKey::new(&store))
        .or_else(|| native_instance_accessor_key(value))
}
fn native_object_frozen(value: &NativeValue) -> bool {
    native_getter_registry_key(value).is_some_and(|key| {
        runtime::weak_map_get::<NativeGetters>(&key, &key)
            .is_some_and(|registry| registry.frozen)
    })
}
fn native_is_frozen_value(value: NativeValue) -> bool {
    match &value {
        NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_)
        | NativeValue::BigInt(_) | NativeValue::Boolean(_) | NativeValue::String(_)
        | NativeValue::Symbol(_) => true,
        NativeValue::Object(_) | NativeValue::Record(_, _) => native_object_frozen(&value),
        _ => runtime::throw_error_code(
            "scriptc SC1031: Object.isFrozen requires native object integrity semantics".into(),
            "SC1031",
        ),
    }
}
fn native_frozen_string_write_blocked(value: &NativeValue, key: &runtime::JsString) -> bool {
    match native_getter_lookup(value, key) {
        Some(runtime::OrdinaryProperty::Accessor(property)) => matches!(property.set, NativeValue::Undefined),
        Some(runtime::OrdinaryProperty::Data(property)) => !property.writable,
        None => native_object_frozen(value),
    }
}
fn native_freeze_value(value: NativeValue) -> NativeValue {
    let store = match &value {
        NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_)
        | NativeValue::BigInt(_) | NativeValue::Boolean(_) | NativeValue::String(_)
        | NativeValue::Symbol(_) => return value,
        NativeValue::Array(array) => {
            runtime::array_freeze(array);
            return value;
        }
        NativeValue::Object(store) | NativeValue::Record(_, store) => store.clone(),
        _ => runtime::throw_error_code(
            "scriptc SC1031: Object.freeze requires native object integrity semantics".into(),
            "SC1031",
        ),
    };
    let weak = runtime::WeakKey::new(&store);
    let mut registry = runtime::weak_map_get::<NativeGetters>(&weak, &weak).unwrap_or_default();
    let entries = store.with(|data| data.entries.clone());
    for (key, field) in entries {
        let key = runtime::PropertyKey::String(key);
        if registry.properties.get(&key).is_none() {
            let descriptor = runtime::OrdinaryDescriptor {
                value: Some(field), writable: Some(true), enumerable: Some(true),
                configurable: Some(true), get: None, set: None,
            };
            registry.properties.define(key, &descriptor, true, NativeValue::Undefined, native_value_eq)
                .expect("existing native record property");
        }
    }
    for key in registry.properties.own_keys(false) {
        let is_data = matches!(registry.properties.get(&key), Some(runtime::OrdinaryProperty::Data(_)));
        let descriptor = runtime::OrdinaryDescriptor {
            writable: is_data.then_some(false), configurable: Some(false), ..Default::default()
        };
        registry.properties.define(key, &descriptor, true, NativeValue::Undefined, native_value_eq)
            .expect("freezing an existing native property");
    }
    store.with_mut(|data| {
        if let Some(table) = data.symbol_properties.as_mut() {
            for key in table.own_keys(false) {
                let descriptor = runtime::DataDescriptor {
                    value: None, writable: Some(false), enumerable: None, configurable: Some(false),
                };
                table.define(key, &descriptor, true, NativeValue::Undefined, native_value_eq)
                    .expect("freezing an existing native symbol property");
            }
        }
    });
    registry.frozen = true;
    runtime::weak_map_set(&weak, &weak, registry);
    NATIVE_HAS_GETTERS.with(|flag| flag.set(true));
    value
}
fn native_getter_lookup(
    value: &NativeValue,
    key: &runtime::JsString,
) -> Option<runtime::OrdinaryProperty<NativeValue>> {
    if !NATIVE_HAS_GETTERS.with(|flag| flag.get()) {
        return None;
    }
    let weak = native_getter_registry_key(value)?;
    runtime::weak_map_get::<NativeGetters>(&weak, &weak)
        .unwrap_or_default()
        .properties
        .get(&runtime::PropertyKey::String(key.clone()))
        .cloned()
}
fn native_getter_read(value: &NativeValue, key: &runtime::JsString) -> Option<NativeValue> {
    if key == "locked" {
        if let NativeValue::WebBytesStream(stream) = value {
            return Some(NativeValue::Boolean(runtime::web_stream_locked(stream)));
        }
        if let NativeValue::WebTextStream(stream) = value {
            return Some(NativeValue::Boolean(runtime::web_stream_locked(stream)));
        }
    }
    if key == "desiredSize"
        && let NativeValue::WebBytesController(stream) = value
    {
        return Some(match runtime::web_stream_desired_size(stream) {
            Some(size) => NativeValue::Number(size),
            None => NativeValue::Null,
        });
    }
    if let NativeValue::DebugLog(_, enabled) = value {
        return (key == "enabled").then_some(NativeValue::Boolean(*enabled));
    }
    if let NativeValue::AbortSignal(signal) = value {
        return Some(match key.well_formed_utf8().unwrap_or("") {
            "aborted" => NativeValue::Boolean(runtime::abort_signal_aborted(signal)),
            "reason" => runtime::abort_signal_reason(signal).unwrap_or(NativeValue::Undefined),
            _ => return None,
        });
    }
    if matches!(value, NativeValue::AbortSignalConstructor) {
        return Some(match key.well_formed_utf8().unwrap_or("") {
            "timeout" => NativeValue::AbortSignalStatic(0),
            "any" => NativeValue::AbortSignalStatic(1),
            "abort" => NativeValue::AbortSignalStatic(2),
            _ => return None,
        });
    }
    native_getter_read_with_receiver(value, key, value.clone())
}
fn native_getter_read_with_receiver(
    value: &NativeValue,
    key: &runtime::JsString,
    receiver: NativeValue,
) -> Option<NativeValue> {
    match native_getter_lookup(value, key)? {
        runtime::OrdinaryProperty::Accessor(property) => {
            if matches!(property.get, NativeValue::Undefined) {
                Some(NativeValue::Undefined)
            } else {
                Some(native_value_call_with_this(
                    property.get,
                    receiver,
                    vec![],
                    "getter",
                ))
            }
        }
        runtime::OrdinaryProperty::Data(property) => Some(property.value),
    }
}
fn native_getter_write(value: &NativeValue, key: &runtime::JsString, field: NativeValue) -> bool {
    native_getter_write_with_receiver(value, key, field, value.clone())
}
fn native_getter_write_with_receiver(
    value: &NativeValue,
    key: &runtime::JsString,
    field: NativeValue,
    receiver: NativeValue,
) -> bool {
    match native_getter_lookup(value, key) {
        Some(runtime::OrdinaryProperty::Accessor(property)) => {
            if matches!(property.set, NativeValue::Undefined) {
                runtime::throw_type_error(format!("Cannot set property {} which has only a getter", key));
            }
            native_value_call_with_this(property.set, receiver, vec![field], "setter");
            true
        }
        Some(runtime::OrdinaryProperty::Data(property)) => {
            if !property.writable {
                runtime::throw_type_error(format!("Cannot assign to read only property '{}'", key));
            }
            let weak = native_getter_registry_key(value).expect("descriptor owner");
            let mut registry = runtime::weak_map_get::<NativeGetters>(&weak, &weak).expect("descriptor registry");
            let descriptor = runtime::OrdinaryDescriptor {
                value: Some(field),
                ..Default::default()
            };
            registry.properties.define(
                runtime::PropertyKey::String(key.clone()),
                &descriptor,
                true,
                NativeValue::Undefined,
                native_value_eq,
            ).expect("writable data property");
            runtime::weak_map_set(&weak, &weak, registry);
            true
        }
        None if native_object_frozen(value) => {
            runtime::throw_type_error(format!("Cannot add property {}, object is not extensible", key));
        }
        None => false,
    }
}
fn native_getter_delete(value: &NativeValue, key: &runtime::JsString) -> bool {
    if !NATIVE_HAS_GETTERS.with(|flag| flag.get()) {
        return true;
    }
    let Some(weak) = native_getter_registry_key(value) else {
        return true;
    };
    let Some(mut registry) = runtime::weak_map_get::<NativeGetters>(&weak, &weak) else {
        return true;
    };
    let result = registry
        .properties
        .delete(&runtime::PropertyKey::String(key.clone()));
    if result {
        if registry.properties.own_keys(false).is_empty() && !registry.frozen {
            runtime::weak_map_delete::<NativeGetters>(&weak, &weak);
        } else {
            runtime::weak_map_set(&weak, &weak, registry);
        }
    }
    result
}
fn native_getter_own_keys(value: &NativeValue) -> Vec<runtime::JsString> {
    let Some(key) = native_getter_registry_key(value) else { return Vec::new() };
    runtime::weak_map_get::<NativeGetters>(&key, &key)
        .unwrap_or_default()
        .properties
        .own_keys(false)
        .into_iter()
        .filter_map(|key| match key {
            runtime::PropertyKey::String(key) => Some(key),
            runtime::PropertyKey::Symbol(_) => None,
        })
        .collect()
}
fn native_getter_enumerable(value: &NativeValue, key: &runtime::JsString) -> bool {
    match native_getter_lookup(value, key) {
        Some(runtime::OrdinaryProperty::Accessor(property)) => property.enumerable,
        Some(runtime::OrdinaryProperty::Data(property)) => property.enumerable,
        None => true,
    }
}
fn native_getter_has_any(value: &NativeValue) -> bool {
    if !NATIVE_HAS_GETTERS.with(|flag| flag.get()) {
        return false;
    }
    native_getter_registry_key(value).is_some_and(|key| {
        !runtime::weak_map_get::<NativeGetters>(&key, &key)
            .unwrap_or_default()
            .properties
            .own_keys(false)
            .is_empty()
    })
}
fn native_own_property_descriptor(target: NativeValue, key: NativeValue) -> NativeValue {
    if matches!(target, NativeValue::Null | NativeValue::Undefined) {
        runtime::throw_type_error("Cannot convert undefined or null to object".into());
    }
    let key = match key {
        value @ (NativeValue::Undefined | NativeValue::Null | NativeValue::Number(_)
            | NativeValue::Boolean(_) | NativeValue::BigInt(_)) => NativeValue::String(native_value_string(value)),
        other => other,
    };
    let property = match key {
        NativeValue::String(key) => native_getter_lookup(&target, &key)
        .or_else(|| native_array_own_descriptor(&target, &key)).or_else(|| {
            native_getter_store(&target).and_then(|store| {
                store.with(|data| {
                    data.entries
                        .iter()
                        .find(|(name, _)| name == &key)
                        .map(|(_, value)| {
                            runtime::OrdinaryProperty::Data(runtime::DataProperty {
                                value: value.clone(),
                                writable: true,
                                enumerable: true,
                                configurable: true,
                            })
                        })
                })
            })
        }),
        NativeValue::Symbol(key) => native_value_own_symbol_property(&target, &key)
            .map(runtime::OrdinaryProperty::Data),
        _ => runtime::throw_type_error("Reflect.getOwnPropertyDescriptor requires a property key".into()),
    };
    let Some(property) = property else {
        return NativeValue::Undefined;
    };
    let mut entries = Vec::new();
    let mut push = |name: &str, value: NativeValue| {
        native_record_define(&mut entries, runtime::string(name), value);
    };
    match property {
        runtime::OrdinaryProperty::Data(property) => {
            push("value", property.value);
            push("writable", NativeValue::Boolean(property.writable));
            push("enumerable", NativeValue::Boolean(property.enumerable));
            push("configurable", NativeValue::Boolean(property.configurable));
        }
        runtime::OrdinaryProperty::Accessor(property) => {
            push("get", property.get);
            push("set", property.set);
            push("enumerable", NativeValue::Boolean(property.enumerable));
            push("configurable", NativeValue::Boolean(property.configurable));
        }
    }
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        entries,
        hash_index: NativeHashIndex::default(),
        symbol_properties: None,
    }))
}
fn native_descriptor_flag(value: NativeValue, name: &str) -> Option<bool> {
    match value {
        NativeValue::Undefined => None,
        NativeValue::Boolean(value) => Some(value),
        _ => runtime::throw_error_code(
            format!("scriptc SC1031: property descriptor {name} requires a boolean"),
            "SC1031",
        ),
    }
}
fn native_define_ordinary_accessor(
    target: NativeValue,
    key: NativeValue,
    getter: NativeValue,
    setter: NativeValue,
    enumerable: NativeValue,
    configurable: NativeValue,
) -> NativeValue {
    let NativeValue::String(key) = key else {
        runtime::throw_error_code(
            "scriptc SC1031: accessor keys require strings".into(),
            "SC1031",
        )
    };
    if !native_value_is_function(&getter) && !matches!(getter, NativeValue::Undefined) {
        runtime::throw_type_error("Getter must be a function or undefined".into());
    }
    if !native_value_is_function(&setter) && !matches!(setter, NativeValue::Undefined) {
        runtime::throw_type_error("Setter must be a function or undefined".into());
    }
    let Some(weak) = native_getter_registry_key(&target) else {
        runtime::throw_error_code(
            "scriptc SC1031: accessor target requires an ordinary object or function".into(),
            "SC1031",
        );
    };
    let mut registry = runtime::weak_map_get::<NativeGetters>(&weak, &weak).unwrap_or_default();
    let property_key = runtime::PropertyKey::String(key.clone());
    if registry.properties.get(&property_key).is_none() {
        if let Some(store) = native_getter_store(&target) {
            if let Some(value) = store.with(|data| {
                data.entries
                    .iter()
                    .find(|(name, _)| name == &key)
                    .map(|(_, value)| value.clone())
            }) {
                let data = runtime::OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(true),
                    enumerable: Some(true),
                    configurable: Some(true),
                    get: None,
                    set: None,
                };
                registry
                    .properties
                    .define(
                        property_key.clone(),
                        &data,
                        true,
                        NativeValue::Undefined,
                        native_value_eq,
                    )
                    .expect("existing data property");
            }
        }
    }
    let descriptor = runtime::OrdinaryDescriptor {
        get: Some(getter),
        set: Some(setter),
        enumerable: native_descriptor_flag(enumerable, "enumerable"),
        configurable: native_descriptor_flag(configurable, "configurable"),
        ..Default::default()
    };
    if registry
        .properties
        .define(
            property_key,
            &descriptor,
            !registry.frozen,
            NativeValue::Undefined,
            native_value_eq,
        )
        .is_err()
    {
        runtime::throw_type_error(format!("Cannot redefine property: {}", key));
    }
    if let Some(store) = native_getter_store(&target) {
        store.with_mut(|data| {
            if !data.entries.iter().any(|(name, _)| name == &key) {
                data.entries.push((key.clone(), NativeValue::Undefined));
            }
        });
    }
    runtime::weak_map_set(&weak, &weak, registry);
    NATIVE_HAS_GETTERS.with(|flag| flag.set(true));
    target
}
fn native_define_ordinary_setter(
    target: NativeValue,
    key: NativeValue,
    setter: NativeValue,
    enumerable: NativeValue,
    configurable: NativeValue,
) -> NativeValue {
    let NativeValue::String(key) = key else {
        runtime::throw_error_code("scriptc SC1031: setter keys require strings".into(), "SC1031")
    };
    if !native_value_is_function(&setter) && !matches!(setter, NativeValue::Undefined) {
        runtime::throw_type_error("Setter must be a function or undefined".into());
    }
    let Some(weak) = native_getter_registry_key(&target) else {
        runtime::throw_error_code(
            "scriptc SC1031: setter target requires an ordinary object, function, or class instance".into(),
            "SC1031",
        );
    };
    let mut registry = runtime::weak_map_get::<NativeGetters>(&weak, &weak).unwrap_or_default();
    let property_key = runtime::PropertyKey::String(key.clone());
    if registry.properties.get(&property_key).is_none() {
        if let Some(store) = native_getter_store(&target) {
            if let Some(value) = store.with(|data| data.entries.iter().find(|(name, _)| name == &key).map(|(_, value)| value.clone())) {
                let data = runtime::OrdinaryDescriptor {
                    value: Some(value), writable: Some(true), enumerable: Some(true), configurable: Some(true), get: None, set: None,
                };
                registry.properties.define(property_key.clone(), &data, true, NativeValue::Undefined, native_value_eq).expect("existing data property");
            }
        }
    }
    let descriptor = runtime::OrdinaryDescriptor {
        set: Some(setter),
        enumerable: native_descriptor_flag(enumerable, "enumerable"),
        configurable: native_descriptor_flag(configurable, "configurable"),
        ..Default::default()
    };
    if registry.properties.define(property_key, &descriptor, !registry.frozen, NativeValue::Undefined, native_value_eq).is_err() {
        runtime::throw_type_error(format!("Cannot redefine property: {}", key));
    }
    if let Some(store) = native_getter_store(&target) {
        store.with_mut(|data| {
            if !data.entries.iter().any(|(name, _)| name == &key) {
                data.entries.push((key.clone(), NativeValue::Undefined));
            }
        });
    }
    runtime::weak_map_set(&weak, &weak, registry);
    NATIVE_HAS_GETTERS.with(|flag| flag.set(true));
    target
}
fn native_getter_define_data(
    target: &NativeValue,
    key: &runtime::JsString,
    value: NativeValue,
) -> bool {
    if !NATIVE_HAS_GETTERS.with(|flag| flag.get()) {
        return false;
    }
    let Some(store) = native_getter_store(target) else {
        return false;
    };
    let mut registry = native_getter_registry(&store);
    let property_key = runtime::PropertyKey::String(key.clone());
    if registry.properties.get(&property_key).is_none() {
        return false;
    }
    let descriptor = runtime::OrdinaryDescriptor {
        value: Some(value.clone()),
        writable: Some(true),
        enumerable: Some(true),
        configurable: Some(true),
        get: None,
        set: None,
    };
    if registry
        .properties
        .define(
            property_key.clone(),
            &descriptor,
            true,
            NativeValue::Undefined,
            native_value_eq,
        )
        .is_err()
    {
        runtime::throw_type_error(format!("Cannot redefine property: {}", key));
    }
    assert!(registry.properties.delete(&property_key));
    store.with_mut(|data| native_record_define(&mut data.entries, key.clone(), value));
    let weak = runtime::WeakKey::new(&store);
    if registry.properties.own_keys(false).is_empty() && !registry.frozen {
        runtime::weak_map_delete::<NativeGetters>(&weak, &weak);
    } else {
        runtime::weak_map_set(&weak, &weak, registry);
    }
    true
}
fn native_define_ordinary_data_descriptor(
    target: &NativeValue,
    key: &runtime::JsString,
    descriptor: runtime::DataDescriptor<NativeValue>,
) -> bool {
    let Some(weak) = native_getter_registry_key(target) else { return false };
    let mut registry = runtime::weak_map_get::<NativeGetters>(&weak, &weak).unwrap_or_default();
    let property_key = runtime::PropertyKey::String(key.clone());
    if registry.properties.get(&property_key).is_none() {
        if let Some(store) = native_getter_store(target) {
            if let Some(value) = store.with(|data| data.entries.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone())) {
                let current = runtime::OrdinaryDescriptor {
                    value: Some(value), writable: Some(true), enumerable: Some(true), configurable: Some(true), get: None, set: None,
                };
                registry.properties.define(property_key.clone(), &current, true, NativeValue::Undefined, native_value_eq).expect("existing data property");
            }
        }
    }
    let descriptor = runtime::OrdinaryDescriptor {
        value: descriptor.value,
        writable: descriptor.writable,
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
        get: None,
        set: None,
    };
    if registry.properties.define(property_key, &descriptor, !registry.frozen, NativeValue::Undefined, native_value_eq).is_err() {
        runtime::throw_type_error(format!("Cannot redefine property: {}", key));
    }
    if let Some(store) = native_getter_store(target) {
        store.with_mut(|data| {
            if !data.entries.iter().any(|(name, _)| name == key) {
                data.entries.push((key.clone(), NativeValue::Undefined));
            }
        });
    }
    runtime::weak_map_set(&weak, &weak, registry);
    NATIVE_HAS_GETTERS.with(|flag| flag.set(true));
    true
}
fn native_define_ordinary_getter(
    target: NativeValue,
    key: NativeValue,
    getter: NativeValue,
    enumerable: NativeValue,
    configurable: NativeValue,
) -> NativeValue {
    let NativeValue::String(key) = key else {
        runtime::throw_error_code(
            "scriptc SC1031: getter keys require strings".into(),
            "SC1031",
        )
    };
    if !native_value_is_function(&getter) && !matches!(getter, NativeValue::Undefined) {
        runtime::throw_type_error("Getter must be a function or undefined".into());
    }
    let Some(weak) = native_getter_registry_key(&target) else {
        runtime::throw_error_code(
            "scriptc SC1031: getter target requires an ordinary object, function, or class instance".into(),
            "SC1031",
        );
    };
    if native_function_properties(&target).is_some() {
        native_function_data_key(&key);
    }
    let mut registry = runtime::weak_map_get::<NativeGetters>(&weak, &weak).unwrap_or_default();
    let property_key = runtime::PropertyKey::String(key.clone());
    if registry.properties.get(&property_key).is_none() {
        if let Some(value) = native_getter_store(&target).and_then(|store| store.with(|data| {
            data.entries
                .iter()
                .find(|(name, _)| name == &key)
                .map(|(_, value)| value.clone())
        })) {
            let data = runtime::OrdinaryDescriptor {
                value: Some(value),
                writable: Some(true),
                enumerable: Some(true),
                configurable: Some(true),
                get: None,
                set: None,
            };
            registry
                .properties
                .define(
                    property_key.clone(),
                    &data,
                    true,
                    NativeValue::Undefined,
                    native_value_eq,
                )
                .expect("existing data property");
        }
    }
    let descriptor = runtime::OrdinaryDescriptor {
        get: Some(getter),
        enumerable: native_descriptor_flag(enumerable, "enumerable"),
        configurable: native_descriptor_flag(configurable, "configurable"),
        ..Default::default()
    };
    if registry
        .properties
        .define(
            property_key,
            &descriptor,
            !registry.frozen,
            NativeValue::Undefined,
            native_value_eq,
        )
        .is_err()
    {
        runtime::throw_type_error(format!("Cannot redefine property: {}", key));
    }
    if let Some(store) = native_getter_store(&target) {
        store.with_mut(|data| {
            if !data.entries.iter().any(|(name, _)| name == &key) {
                data.entries.push((key, NativeValue::Undefined));
            }
        });
    }
    runtime::weak_map_set(&weak, &weak, registry);
    NATIVE_HAS_GETTERS.with(|flag| flag.set(true));
    target
}
