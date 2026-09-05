// Host functions: scriptc closures the embedded realm can call.
//
// A marshaled closure becomes a native boa function whose arguments cross
// as handles (bytes copied eagerly) and whose result crosses like a call
// argument. Included by lib.rs next to island_eval.rs; the callback table
// (ISLAND_HOST_CALLBACKS) stays in island_eval.rs with the realm state.

/// One engine argument as the host closure sees it.
///
/// The raw value covers every primitive extraction. `bytes` is copied out
/// eagerly at the boundary because a Uint8Array cannot be read without
/// the engine context, and the context is only borrowable inside the
/// engine's own call — by the time the generated closure body runs, the
/// island state is already borrowed by the call that reached it.
#[derive(Clone)]
pub struct IslandHostArgument {
    value: IslandValue,
    bytes: Option<Rc<Vec<u8>>>,
}

/// What a marshaled scriptc closure hands back to the engine.
///
/// This mirrors the C island's host-call adapter returns (emit-island.ts's
/// `islandAdapter` tags): primitives by value, `Bytes` as a Uint8Array,
/// and `Json` as text the realm parses — the deep-copy stance the rest of
/// the boundary already takes for composites.
pub enum IslandHostResult {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Bytes(Vec<u8>),
    Json(JsString),
    /// An engine value handed straight back (a callback answering a handle
    /// it received, a dyn callback's island result).
    Island(IslandValue),
}

type IslandHostCallback = Rc<dyn Fn(&[IslandHostArgument]) -> IslandHostResult>;

/// Copy a runtime byte array out for an `IslandHostResult::Bytes`.
pub fn island_bytes_values(bytes: &JsBytes<u8>) -> Vec<u8> {
    bytes_values(bytes)
}

/// A `jsval` parameter: the engine handle passes straight through.
pub fn island_host_argument_value(
    arguments: &[IslandHostArgument],
    index: usize,
) -> IslandValue {
    arguments
        .get(index)
        .map_or_else(island_value_undefined, |argument| argument.value.clone())
}

pub fn island_value_host_function(
    arity: usize,
    callback: IslandHostCallback,
) -> IslandValue {
    let id = ISLAND_HOST_CALLBACK_ID.with(|next| {
        let id = next.get();
        next.set(id.wrapping_add(1));
        id
    });
    ISLAND_HOST_CALLBACKS.with(|callbacks| callbacks.borrow_mut().insert(id, callback));
    with_island_state(|state| {
        // The callback is arbitrary generated Rust, so a scriptc `throw`
        // inside it is the EXPECTED case, not the exotic one: the
        // boundary is what turns it into an exception the island's
        // JavaScript can catch instead of an unwind through boa.
        let native = NativeFunction::from_copy_closure(move |_this, arguments, context| {
            island_boundary(context, |context| {
                let arguments = arguments
                    .iter()
                    .cloned()
                    .map(|value| island_host_argument(value, context))
                    .collect::<JsResult<Vec<_>>>()?;
                // The callback is scriptc code: it may call back into the
                // realm (a signal read, a handle it received), so the realm
                // re-enters for its duration.
                // The callback leaves the table before it runs: a
                // callback that marshals ANOTHER callback (solid's
                // createRoot handing closures around) registers into the
                // same table while it executes.
                let callback = ISLAND_HOST_CALLBACKS.with(|callbacks| {
                    callbacks
                        .borrow()
                        .get(&id)
                        .cloned()
                        .expect("scriptc: missing island host callback")
                });
                let result = island_reenter(context, || callback(&arguments));
                island_host_result_value(result, context)
            })
        });
        let function = FunctionObjectBuilder::new(state.context.realm(), native)
            .length(arity)
            .build();
        IslandValue(function.into())
    })
}

/// Wrap one borrowed engine argument, copying a Uint8Array out while the
/// engine context is still reachable.
fn island_host_argument(value: JsValue, context: &mut Context) -> JsResult<IslandHostArgument> {
    let bytes = value
        .as_object()
        .and_then(|object| BoaJsUint8Array::from_object(object).ok())
        .map(|array| array.to_vec(context))
        .transpose()?
        .map(Rc::new);
    Ok(IslandHostArgument { value: IslandValue(value), bytes })
}

/// Marshal a closure result back into the realm.
fn island_host_result_value(result: IslandHostResult, context: &mut Context) -> JsResult<JsValue> {
    Ok(match result {
        IslandHostResult::Undefined => JsValue::undefined(),
        IslandHostResult::Null => JsValue::null(),
        IslandHostResult::Bool(value) => JsValue::from(value),
        IslandHostResult::Number(value) => JsValue::from(value),
        IslandHostResult::String(value) => {
            JsValue::from(boa_engine::JsString::from(value.as_ref()))
        }
        IslandHostResult::Bytes(value) => BoaJsUint8Array::from_iter(value, context)?.into(),
        IslandHostResult::Json(value) => island_parse_json(&value, context)?,
        IslandHostResult::Island(value) => value.0,
    })
}
