/* ── properties ────────────────────────────────────────────────────── */

pub fn get(target: &Value, key: &str) -> Result<Value, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &target.0);
    let Some(object) = local.to_object(tc) else {
        return Err(Error::text("TypeError", format!("cannot read property '{key}' of {}", local.to_rust_string_lossy(tc))));
    };
    let key_local = v8::String::new(tc, key).unwrap_or_else(|| v8::String::empty(tc));
    match object.get(tc, key_local.into()) {
        Some(value) => Ok(Value(v8::Global::new(tc, value))),
        None => Err(caught!(tc)),
    }
}

pub fn set(target: &Value, key: &str, value: &Value) -> Result<(), Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &target.0);
    let Some(object) = local.to_object(tc) else {
        return Err(Error::text("TypeError", format!("cannot set property '{key}' of {}", local.to_rust_string_lossy(tc))));
    };
    let key_local = v8::String::new(tc, key).unwrap_or_else(|| v8::String::empty(tc));
    let value_local = v8::Local::new(tc, &value.0);
    match object.set(tc, key_local.into(), value_local) {
        Some(_) => Ok(()),
        None => Err(caught!(tc)),
    }
}

pub fn get_index(target: &Value, index: u32) -> Result<Value, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &target.0);
    let Some(object) = local.to_object(tc) else {
        return Err(Error::text("TypeError", "cannot index a non-object"));
    };
    match object.get_index(tc, index) {
        Some(value) => Ok(Value(v8::Global::new(tc, value))),
        None => Err(caught!(tc)),
    }
}

pub fn set_index(target: &Value, index: u32, value: &Value) -> Result<(), Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &target.0);
    let Some(object) = local.to_object(tc) else {
        return Err(Error::text("TypeError", "cannot index a non-object"));
    };
    let value_local = v8::Local::new(tc, &value.0);
    match object.set_index(tc, index, value_local) {
        Some(_) => Ok(()),
        None => Err(caught!(tc)),
    }
}

/// The value's own enumerable string keys, in JavaScript order.
pub fn own_keys(target: &Value) -> Result<Vec<String>, Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let local = v8::Local::new(tc, &target.0);
    let Some(object) = local.to_object(tc) else {
        return Ok(Vec::new());
    };
    let Some(names) = object.get_own_property_names(tc, v8::GetPropertyNamesArgs::default()) else {
        return Err(caught!(tc));
    };
    let mut out = Vec::with_capacity(names.length() as usize);
    for index in 0..names.length() {
        if let Some(name) = names.get_index(tc, index) {
            out.push(name.to_rust_string_lossy(tc));
        }
    }
    Ok(out)
}

/// CopyDataProperties: snapshot all own keys, re-check each descriptor, then
/// create a data property. Symbol keys and nested object identity stay intact.
pub fn copy_data_properties(target: &Value, source: &Value) -> Result<(), Error> {
    enter!(scope);
    v8::tc_scope!(let tc, scope);
    let target = v8::Local::new(tc, &target.0);
    let Ok(target) = v8::Local::<v8::Object>::try_from(target) else {
        return Err(Error::text("TypeError", "object spread target is not an object"));
    };
    let source = v8::Local::new(tc, &source.0);
    if source.is_null_or_undefined() { return Ok(()); }
    let Some(source) = source.to_object(tc) else { return Err(caught!(tc)); };
    let args = v8::GetPropertyNamesArgs {
        property_filter: v8::PropertyFilter::ALL_PROPERTIES,
        key_conversion: v8::KeyConversionMode::ConvertToString,
        ..Default::default()
    };
    let Some(keys) = source.get_own_property_names(tc, args) else { return Err(caught!(tc)); };
    let enumerable = v8::String::new(tc, "enumerable").unwrap();
    for index in 0..keys.length() {
        let Some(key) = keys.get_index(tc, index) else { return Err(caught!(tc)); };
        let key = v8::Local::<v8::Name>::try_from(key)
            .expect("V8 own keys contain only strings and symbols");
        let Some(descriptor) = source.get_own_property_descriptor(tc, key) else { return Err(caught!(tc)); };
        if descriptor.is_undefined() { continue; }
        let descriptor = v8::Local::<v8::Object>::try_from(descriptor)
            .expect("V8 property descriptor is an object");
        let Some(flag) = descriptor.get(tc, enumerable.into()) else { return Err(caught!(tc)); };
        if !flag.boolean_value(tc) { continue; }
        let Some(value) = source.get(tc, key.into()) else { return Err(caught!(tc)); };
        match target.create_data_property(tc, key, value) {
            Some(true) => {},
            Some(false) => return Err(Error::text("TypeError", "cannot create object spread property")),
            None => return Err(caught!(tc)),
        }
    }
    Ok(())
}
