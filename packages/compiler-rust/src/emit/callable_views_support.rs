// A bound function and all of its callable views share one property store.
// The weak-key association retains the store only while the bound value lives.
#[derive(Clone)]
struct NativeBoundProperties(runtime::Gc<NativeRecordData>);
impl runtime::HeapValue for NativeBoundProperties {
    fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) { tracer.edge(&self.0); }
}
fn native_bound_properties(bound: &runtime::JsArray<NativeValue>) -> runtime::Gc<NativeRecordData> {
    let key = runtime::WeakKey::new(bound);
    if let Some(properties) = runtime::weak_map_get::<NativeBoundProperties>(&key, &key) {
        return properties.0;
    }
    let properties = runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() });
    runtime::weak_map_set(&key, &key, NativeBoundProperties(properties.clone()));
    properties
}

// A callable record view shares the function's property store. The ephemeron
// retains the function while that store is reachable without introducing a
// permanent cycle between the function and its view.
#[derive(Clone)]
struct NativeCallableView {
    function: NativeValue,
    record_tags: Vec<usize>,
}
impl runtime::HeapValue for NativeCallableView {
    fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) {
        self.function.trace_native(tracer);
    }
}
thread_local! { static NATIVE_HAS_CALLABLE_VIEWS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
fn native_callable_view(store: &runtime::Gc<NativeRecordData>) -> Option<NativeCallableView> {
    if !NATIVE_HAS_CALLABLE_VIEWS.with(|flag| flag.get()) {
        return None;
    }
    let key = runtime::WeakKey::new(store);
    runtime::weak_map_get::<NativeCallableView>(&key, &key)
}
fn native_callable_attach(
    store: runtime::Gc<NativeRecordData>,
    function: NativeValue,
    tag: usize,
) -> runtime::Gc<NativeRecordData> {
    let key = runtime::WeakKey::new(&store);
    let mut view = native_callable_view(&store).unwrap_or_else(|| NativeCallableView {
        function: function.clone(),
        record_tags: Vec::new(),
    });
    if !native_value_eq(&view.function, &function) {
        runtime::throw_error_code(
            "scriptc SC1031: callable property storage already has a different identity".into(),
            "SC1031",
        );
    }
    if !view.record_tags.contains(&tag) {
        view.record_tags.push(tag);
    }
    runtime::weak_map_set(&key, &key, view);
    NATIVE_HAS_CALLABLE_VIEWS.with(|flag| flag.set(true));
    store
}
fn native_callable_receiver(store: &runtime::Gc<NativeRecordData>) -> NativeValue {
    native_callable_view(store)
        .map(|view| view.function)
        .unwrap_or_else(|| NativeValue::Object(store.clone()))
}
fn native_callable_cast(value: &NativeValue, tag: usize) -> Option<runtime::Gc<NativeRecordData>> {
    let store = native_function_properties(value)?;
    native_callable_view(&store)
        .filter(|view| view.record_tags.contains(&tag))
        .map(|_| store)
}

// The prototype is an ephemeron of the instance, so it is retained while the
// instance is live without extending the instance's lifetime.
#[derive(Clone)]
struct NativeInstancePrototype(NativeValue);
impl runtime::HeapValue for NativeInstancePrototype {
    fn trace_value(&self, tracer: &mut runtime::Tracer<'_>) {
        self.0.trace_native(tracer);
    }
}
fn native_instance_prototype(object: &runtime::Gc<NativeRecordData>) -> Option<NativeValue> {
    let key = runtime::WeakKey::new(object);
    runtime::weak_map_get::<NativeInstancePrototype>(&key, &key).map(|value| value.0)
}
fn native_set_instance_prototype(
    object: &runtime::Gc<NativeRecordData>,
    prototype: NativeValue,
) {
    let key = runtime::WeakKey::new(object);
    runtime::weak_map_set(&key, &key, NativeInstancePrototype(prototype));
}
fn native_null_constructor() -> NativeValue {
    let prototype = NativeValue::Object(runtime::Gc::new(NativeMap { null_prototype: true, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() }));
    let store = runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() });
    let owner = NativeValue::Object(store.clone());
    native_define_ordinary_data_descriptor(&owner, &runtime::string("prototype"), runtime::DataDescriptor {
        value: Some(prototype), writable: Some(true), enumerable: Some(false), configurable: Some(false),
    });
    NativeValue::NullConstructor(store)
}
fn native_construct_null(constructor: NativeValue) -> NativeValue {
    let NativeValue::NullConstructor(store) = constructor else {
        runtime::throw_type_error("value is not a constructor".into());
    };
    let prototype = native_value_get(NativeValue::Object(store), runtime::string("prototype"));
    let prototype = match prototype {
        NativeValue::Object(_) | NativeValue::Record(..) => prototype,
        _ => native_object_prototype_value(),
    };
    let object = runtime::Gc::new(NativeMap { null_prototype: false, symbol_properties: None, entries: Vec::new(), hash_index: NativeHashIndex::default() });
    native_set_instance_prototype(&object, prototype);
    NativeValue::Object(object)
}

fn native_function_prototype(constructor: NativeValue) -> NativeValue {
    let Some(store) = native_function_properties(&constructor) else {
        runtime::throw_type_error("value is not a constructor".into());
    };
    if let Some(value) = store.with(|data| {
        data.entries
            .iter()
            .find(|(key, _)| key == "prototype")
            .map(|(_, value)| value.clone())
    }) {
        return value;
    }
    let prototype = NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: vec![(runtime::string("constructor"), constructor)],
        hash_index: NativeHashIndex::default(),
    }));
    store.with_mut(|data| {
        data.entries
            .push((runtime::string("prototype"), prototype.clone()));
    });
    prototype
}

fn native_constructor_result_is_object(value: &NativeValue) -> bool {
    !matches!(
        value,
        NativeValue::Undefined
            | NativeValue::Null
            | NativeValue::Number(_)
            | NativeValue::BigInt(_)
            | NativeValue::Boolean(_)
            | NativeValue::String(_)
            | NativeValue::Symbol(_)
    )
}

fn native_construct_callable(constructor: NativeValue, args: Vec<NativeValue>) -> NativeValue {
    if matches!(constructor, NativeValue::RegexConstructor) {
        return native_regex_construct(args, true);
    }
    if !native_value_is_function(&constructor) {
        runtime::throw_type_error("value is not a constructor".into());
    }
    let prototype = match native_function_prototype(constructor.clone()) {
        value @ (NativeValue::Object(_) | NativeValue::Record(..)) => value,
        _ => native_object_prototype_value(),
    };
    let object = runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: Vec::new(),
        hash_index: NativeHashIndex::default(),
    });
    let key = runtime::WeakKey::new(&object);
    runtime::weak_map_set(&key, &key, NativeInstancePrototype(prototype));
    let receiver = NativeValue::Object(object);
    let result = native_value_call_with_this(
        constructor,
        receiver.clone(),
        args,
        "constructor",
    );
    if native_constructor_result_is_object(&result) {
        result
    } else {
        receiver
    }
}
