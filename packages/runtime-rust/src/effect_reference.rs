// Native kernel handles retain their source reference identity when transported
// through unknown. Weak entries canonicalize library constants only while a
// program can still compare them; the cache does not make them permanent roots.
impl JsonObjectDecode for EffectData {
    fn decode_json_object(_: &JsonNode, path: &str) -> Result<Self, String> {
        Err(format!("native kernel reference JSON decoding is unsupported at {path}"))
    }
}

#[derive(Hash, PartialEq, Eq)]
enum EffectReferenceKey {
    Void,
    None,
    EmptyLayer,
    ZeroDuration,
    SchemaPrimitive(String),
    UnknownFromJsonString,
    ServiceDeclaration(String),
}

thread_local! {
    static EFFECT_REFERENCES: RefCell<HashMap<EffectReferenceKey, GcWeak<EffectData>>> = RefCell::new(HashMap::new());
}

fn effect_reference_cached(key: EffectReferenceKey, create: impl FnOnce() -> JsEffect) -> JsEffect {
    if let Some(value) = EFFECT_REFERENCES.with(|values| values.borrow().get(&key).and_then(GcWeak::upgrade)) {
        return value;
    }
    // A constructor may obtain another canonical handle. Never retain the
    // cache borrow while constructing it.
    let value = create();
    EFFECT_REFERENCES.with(|values| {
        let mut values = values.borrow_mut();
        values.retain(|_, value| value.upgrade().is_some());
        values.insert(key, value.downgrade());
    });
    value
}

/// Context service classes are callable JavaScript values; the remaining
/// represented kernel families are objects. This does not invoke the handle.
pub fn effect_reference_typeof(value: &JsEffect) -> &'static str {
    value.with(|value| match value.node {
        EffectNode::ServiceKey(_) => "function",
        _ => "object",
    })
}

/// `Effect.void` is a constant; `Effect.succeed(undefined)` remains fresh.
pub fn effect_void() -> JsEffect {
    effect_reference_cached(EffectReferenceKey::Void, || effect_succeed(effect_box(())))
}

/// `Duration.zero` is a constant; `Duration.millis(0)` remains fresh.
pub fn effect_duration_zero() -> JsEffect {
    effect_reference_cached(EffectReferenceKey::ZeroDuration, || effect_duration_millis(0.0))
}

/// The lookup key and the declaration identity have separate roles: distinct
/// service classes may share a context key while remaining distinct objects.
pub fn effect_service_key_identity(id: &JsString, declaration: &JsString) -> JsEffect {
    effect_reference_cached(EffectReferenceKey::ServiceDeclaration(declaration.to_string()), || effect_service_key(id))
}

/// The exported schema constant differs in identity from an equivalent call
/// to `Schema.fromJsonString(Schema.Unknown)`.
pub fn schema_unknown_from_json_string() -> JsEffect {
    effect_reference_cached(EffectReferenceKey::UnknownFromJsonString, || {
        schema_wrap(&string("fromJsonString"), &schema_prim(&string("unknown")))
    })
}
