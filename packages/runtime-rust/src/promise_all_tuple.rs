/// Fixed heterogeneous Promise.all: each handle retains its native payload
/// type, and the compiler checks the corresponding result field in the IR.
/// Observe directly, without mapping promises (which would add microtasks).
pub fn promise_all_tuple<T, F>(entries: Vec<JsPromiseHandle>, assemble: F) -> JsPromise<T>
where
    T: HeapValue,
    F: FnOnce(Vec<Box<dyn Any>>) -> T + 'static,
{
    struct State<F> {
        values: Vec<Option<Box<dyn Any>>>,
        remaining: usize,
        assemble: Option<F>,
    }

    let result = promise_new();
    if entries.is_empty() {
        promise_run_segment(&result, || { promise_fulfill(&result, assemble(Vec::new())); });
        return result;
    }
    // Reaction captures own this state until settlement. Their strong payload
    // references are conservative roots, as in the homogeneous combinator.
    let state = Rc::new(RefCell::new(State {
        values: (0..entries.len()).map(|_| None).collect(),
        remaining: entries.len(),
        assemble: Some(assemble),
    }));
    for (index, entry) in entries.into_iter().enumerate() {
        let state = state.clone();
        let target = result.clone();
        promise_handle_observe(&entry, Box::new(move |outcome| {
            let action = {
                let mut state = state.borrow_mut();
                if state.assemble.is_none() { return; }
                match outcome {
                    Ok(value) => {
                        state.values[index] = Some(value);
                        state.remaining -= 1;
                        if state.remaining != 0 { return; }
                        let values = std::mem::take(&mut state.values).into_iter()
                            .map(|value| value.expect("scriptc: missing Promise.all tuple value"))
                            .collect();
                        Ok((state.assemble.take().expect("scriptc: missing tuple assembler"), values))
                    }
                    Err(reason) => {
                        state.assemble = None;
                        state.values.clear();
                        Err(reason)
                    }
                }
            };
            match action {
                Ok((assemble, values)) => promise_run_segment(&target, || {
                    promise_fulfill(&target, assemble(values));
                }),
                Err(reason) => { promise_reject(&target, reason); }
            }
        }));
    }
    result
}
