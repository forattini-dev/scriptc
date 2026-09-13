#[test]
fn effect_reference_constants_share_live_identity_without_coalescing_constructors() {
    assert!(effect_void().ptr_eq(&effect_void()));
    assert!(option_none().ptr_eq(&option_none()));
    assert!(layer_empty().ptr_eq(&layer_empty()));
    assert!(effect_duration_zero().ptr_eq(&effect_duration_zero()));
    assert!(schema_unknown_from_json_string().ptr_eq(&schema_unknown_from_json_string()));
    for kind in ["string", "number", "boolean", "unknown", "any", "defect", "null", "undefined", "finite", "int", "numberFromString"] {
        assert!(schema_prim(&string(kind)).ptr_eq(&schema_prim(&string(kind))), "{kind}");
    }
    assert!(!effect_void().ptr_eq(&effect_succeed(effect_box(()))));
    assert!(!effect_succeed(effect_box(7.0)).ptr_eq(&effect_succeed(effect_box(7.0))));
    assert!(!option_some(effect_box(7.0)).ptr_eq(&option_some(effect_box(7.0))));
    assert!(!effect_duration_zero().ptr_eq(&effect_duration_millis(0.0)));
    assert!(!effect_duration_millis(0.0).ptr_eq(&effect_duration_millis(0.0)));
    assert!(!schema_unknown_from_json_string().ptr_eq(&schema_wrap(&string("fromJsonString"), &schema_prim(&string("unknown")))));
    assert!(!schema_struct(Vec::new()).ptr_eq(&schema_struct(Vec::new())));
}

#[test]
fn effect_reference_service_identity_is_separate_from_context_lookup() {
    let id = string("same-key");
    let left = effect_service_key_identity(&id, &string("module:left"));
    let again = effect_service_key_identity(&id, &string("module:left"));
    let right = effect_service_key_identity(&id, &string("module:right"));
    assert!(left.ptr_eq(&again));
    assert!(!left.ptr_eq(&right));
    assert!(!effect_service_key(&id).ptr_eq(&effect_service_key(&id)));
    assert_eq!(effect_unbox::<f64>(&effect_run_sync(&effect_provide_service(&left, &right, effect_box(42.0)))), 42.0);
}

#[test]
fn effect_reference_typeof_preserves_callable_services_and_does_not_execute_effects() {
    let runs = Rc::new(Cell::new(0));
    let observed = runs.clone();
    let deferred = effect_sync(Rc::new(move || {
        observed.set(observed.get() + 1);
        effect_box(observed.get())
    }), super::no_trace());
    for handle in [
        deferred.clone(), effect_succeed(effect_box(7.0)), effect_fail(effect_box("bad")),
        effect_void(), option_none(), option_some(effect_box(7.0)),
        effect_exit_succeed(effect_box(7.0)), effect_exit_fail(effect_box("bad")),
        layer_empty(), effect_duration_zero(), schema_prim(&string("string")),
        effect_ref_make_unsafe(effect_box(7.0)), schema_unknown_from_json_string(),
    ] {
        assert_eq!(effect_reference_typeof(&handle), "object");
    }
    assert_eq!(effect_reference_typeof(&effect_service_key(&string("Service"))), "function");
    assert_eq!(runs.get(), 0);
    // The boxed value is still the same lazy program, even after its original
    // binding is released. Repeated execution remains repeated work.
    let boxed = effect_box(deferred.clone());
    let kept = deferred.downgrade();
    drop(deferred);
    collect_cycles();
    let recovered = effect_unbox::<JsEffect>(&boxed);
    assert!(kept.upgrade().expect("boxed effect must stay alive").ptr_eq(&recovered));
    assert_eq!(effect_unbox::<i32>(&effect_run_sync(&recovered)), 1);
    assert_eq!(effect_unbox::<i32>(&effect_run_sync(&recovered)), 2);
    drop((boxed, recovered));
    assert!(kept.upgrade().is_none());
}

#[test]
fn effect_reference_cache_does_not_root_released_values() {
    let constructors: [fn() -> JsEffect; 6] = [
        effect_void, option_none, layer_empty, effect_duration_zero,
        schema_unknown_from_json_string, || schema_prim(&string("string")),
    ];
    for create in constructors {
        let value = create();
        let alias = create();
        let weak = value.downgrade();
        drop(value);
        collect_cycles();
        assert!(weak.upgrade().expect("live alias").ptr_eq(&alias));
        drop(alias);
        assert!(weak.upgrade().is_none(), "canonical cache must contain only weak references");
        let recreated = create();
        assert!(recreated.ptr_eq(&create()));
    }
    let id = string("temporary-service");
    let value = effect_service_key_identity(&id, &id);
    let weak = value.downgrade();
    drop(value);
    assert!(weak.upgrade().is_none());
    effect_void();
    EFFECT_REFERENCES.with(|values| assert!(!values.borrow().contains_key(&EffectReferenceKey::ServiceDeclaration(id.to_string()))));
}

#[test]
fn effect_reference_exit_values_execute_with_their_original_success_and_failure() {
    let payload = effect_box(42.0);
    let success = effect_exit_succeed(payload.clone());
    assert!(Rc::ptr_eq(&effect_run_sync(&success), &payload));
    assert!(Rc::ptr_eq(&effect_run_sync(&success), &payload));
    let mapped = effect_map(&success, Rc::new(|value| effect_box(effect_unbox::<f64>(&value) + 1.0)), super::no_trace());
    assert_eq!(effect_unbox::<f64>(&effect_run_sync(&mapped)), 43.0);

    let failed = effect_exit_fail(payload.clone());
    let recovered = effect_catch_all(&failed, Rc::new(effect_succeed), super::no_trace());
    assert!(Rc::ptr_eq(&effect_run_sync(&recovered), &payload));
    let Err(EffectFailure::Fail(error)) = exit_of(&effect_run_sync_exit(&failed)) else { panic!("typed failure"); };
    assert!(Rc::ptr_eq(&error, &payload));

    let defect = exit_handle(Err(EffectFailure::Die(payload.clone())));
    let Err(EffectFailure::Die(error)) = exit_of(&effect_run_sync_exit(&defect)) else { panic!("defect"); };
    assert!(Rc::ptr_eq(&error, &payload));
    let interrupted = exit_handle(Err(EffectFailure::Interrupt));
    assert!(matches!(exit_of(&effect_run_sync_exit(&interrupted)), Err(EffectFailure::Interrupt)));
}

#[test]
fn effect_reference_data_handles_do_not_become_executable_by_sharing_the_abi() {
    for handle in [option_none(), option_some(effect_box(7.0)), schema_prim(&string("string")), effect_duration_zero()] {
        let Err(EffectFailure::Die(error)) = exit_of(&effect_run_sync_exit(&handle)) else { panic!("data is not executable"); };
        let error = effect_unbox::<JsError>(&error);
        assert_eq!(error_message(&error), string("scriptc: this kernel data handle is not an effect"));
    }
}

#[test]
fn effect_reference_json_decode_refuses_all_json_shapes_without_allocating_a_handle() {
    for text in ["{}", r#"{"_id":"Exit","_tag":"Success","value":42}"#, "[]", "null", "false", "42", r#""Effect""#] {
        let node = json_parse_node(&string(text)).expect("valid JSON");
        let live_before = LIVE_NODES.with(Cell::get);
        let Err(message) = JsEffect::decode_json(&node, "$.jobs[0].effect") else { panic!("JSON must not construct a kernel handle"); };
        assert_eq!(message, "native kernel reference JSON decoding is unsupported at $.jobs[0].effect");
        assert_eq!(LIVE_NODES.with(Cell::get), live_before);
    }
}

#[test]
fn effect_reference_json_decode_keeps_generic_empty_containers_usable() {
    let empty = json_parse_typed::<JsArray<JsEffect>>(&string("[]"));
    assert_eq!(array_len(&empty), 0.0);
    let present = json_parse_node(&string("[{}]")).expect("valid JSON");
    let Err(message) = JsArray::<JsEffect>::decode_json(&present, "$.jobs") else { panic!("present handles must be refused"); };
    assert_eq!(message, "native kernel reference JSON decoding is unsupported at $.jobs[0]");
}
