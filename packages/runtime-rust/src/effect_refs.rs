/// Synchronized references serialize writes across suspension. Reads observe
/// the last committed value without taking the permit, as Effect's get does.
pub struct EffectRefState {
    value: RefCell<EffectValue>,
    write_permit: Option<Rc<RefCell<Latch>>>,
}

fn ref_cell_of(handle: &JsEffect) -> Rc<EffectRefState> {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::Ref(cell)) => cell.clone(),
        _ => throw_error("scriptc: a Ref handle was expected".to_owned()),
    })
}

fn ref_make(value: EffectValue, synchronized: bool) -> JsEffect {
    effect_new(EffectNode::Data(KernelData::Ref(Rc::new(EffectRefState {
        value: RefCell::new(value),
        write_permit: synchronized.then(|| Latch::new(1.0)),
    }))))
}

pub fn effect_ref_make_unsafe(value: EffectValue) -> JsEffect {
    ref_make(value, false)
}

pub fn effect_sync_ref_make_unsafe(value: EffectValue) -> JsEffect {
    ref_make(value, true)
}

pub fn effect_ref_make(value: EffectValue) -> JsEffect {
    effect_sync(Rc::new(move || effect_box(ref_make(value.clone(), false))), Box::new(|_| {}))
}

pub fn effect_sync_ref_make(value: EffectValue) -> JsEffect {
    effect_sync(Rc::new(move || effect_box(ref_make(value.clone(), true))), Box::new(|_| {}))
}

pub fn effect_ref_get(handle: &JsEffect) -> JsEffect {
    let cell = ref_cell_of(handle);
    effect_sync(Rc::new(move || cell.value.borrow().clone()), Box::new(|_| {}))
}

fn ref_write(handle: &JsEffect, body: &JsEffect) -> JsEffect {
    match &ref_cell_of(handle).write_permit {
        Some(permit) => {
            let take = effect_semaphore_take(permit, 1.0);
            let release = effect_semaphore_release(permit, 1.0);
            effect_zip_right(&take, &effect_ensuring(body, &release))
        }
        None => body.clone(),
    }
}

/// Keep selects unit (0), previous (1), or next (2) for the update family.
pub fn effect_ref_set(handle: &JsEffect, value: EffectValue, keep: f64) -> JsEffect {
    let cell = ref_cell_of(handle);
    let body = effect_sync(Rc::new(move || {
        let previous = cell.value.replace(value.clone());
        if keep as i32 == 1 { previous } else { effect_box(()) }
    }), Box::new(|_| {}));
    ref_write(handle, &body)
}

pub fn effect_ref_update(handle: &JsEffect, f: Rc<dyn Fn(EffectValue) -> EffectValue>, keep: f64, trace: Box<dyn Fn(&mut Tracer<'_>)>) -> JsEffect {
    let cell = ref_cell_of(handle);
    let body = effect_sync(Rc::new(move || {
        let previous = cell.value.borrow().clone();
        let next = f(previous.clone());
        *cell.value.borrow_mut() = next.clone();
        match keep as i32 { 1 => previous, 2 => next, _ => effect_box(()) }
    }), trace);
    ref_write(handle, &body)
}

pub fn effect_ref_update_effect(handle: &JsEffect, f: Rc<dyn Fn(EffectValue) -> JsEffect>, trace: Box<dyn Fn(&mut Tracer<'_>)>) -> JsEffect {
    let cell = ref_cell_of(handle);
    let read = effect_ref_get(handle);
    let body = effect_flat_map(&read, Rc::new(move |previous| {
        let cell = cell.clone();
        effect_map(&f(previous), Rc::new(move |next| {
            *cell.value.borrow_mut() = next;
            effect_box(())
        }), Box::new(|_| {}))
    }), trace);
    ref_write(handle, &body)
}
