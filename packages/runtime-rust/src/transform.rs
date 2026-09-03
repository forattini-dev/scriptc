pub struct TransformData<L, R, W, F, C, T, H>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    duplex: Option<JsDuplex<L, R, W, F, C>>,
    transform_callback: Option<T>,
    flush_callback: Option<H>,
    passthrough: bool,
}

impl<L, R, W, F, C, T, H> Trace for TransformData<L, R, W, F, C, T, H>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(duplex) = &self.duplex {
            tracer.edge(duplex);
        }
        if let Some(callback) = &self.transform_callback {
            callback.trace(tracer);
        }
        if let Some(callback) = &self.flush_callback {
            callback.trace(tracer);
        }
    }
}

impl<L, R, W, F, C, T, H> ClearEdges for TransformData<L, R, W, F, C, T, H>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    fn clear_edges(&mut self) {
        self.duplex = None;
        self.transform_callback = None;
        self.flush_callback = None;
    }
}

pub type JsTransform<L, R, W, F, C, T, H> = Gc<TransformData<L, R, W, F, C, T, H>>;

pub fn transform_new<L, R, W, F, C, T, H>(
    duplex: JsDuplex<L, R, W, F, C>,
    transform_callback: Option<T>,
    flush_callback: Option<H>,
    passthrough: bool,
) -> JsTransform<L, R, W, F, C, T, H>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    Gc::new(TransformData {
        duplex: Some(duplex),
        transform_callback,
        flush_callback,
        passthrough,
    })
}

pub fn transform_duplex<L, R, W, F, C, T, H>(
    transform: &JsTransform<L, R, W, F, C, T, H>,
) -> JsDuplex<L, R, W, F, C>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    transform.with(|data| {
        data.duplex
            .as_ref()
            .expect("scriptc: cleared live Transform duplex")
            .clone()
    })
}

pub fn transform_readable<L, R, W, F, C, T, H>(
    transform: &JsTransform<L, R, W, F, C, T, H>,
) -> JsReadable<L, R>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    duplex_readable(&transform_duplex(transform))
}

pub fn transform_writable<L, R, W, F, C, T, H>(
    transform: &JsTransform<L, R, W, F, C, T, H>,
) -> JsWritable<L, W, F, C>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    duplex_writable(&transform_duplex(transform))
}

pub fn transform_emitter<L, R, W, F, C, T, H>(
    transform: &JsTransform<L, R, W, F, C, T, H>,
) -> JsEventEmitter<L>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    duplex_emitter(&transform_duplex(transform))
}

pub fn transform_callback<L, R, W, F, C, T, H>(
    transform: &JsTransform<L, R, W, F, C, T, H>,
) -> Option<T>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    transform.with(|data| data.transform_callback.clone())
}

pub fn transform_set_callback<L, R, W, F, C, T, H>(
    transform: &JsTransform<L, R, W, F, C, T, H>,
    callback: T,
) where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    transform.with_mut(|data| data.transform_callback = Some(callback));
}

pub fn transform_flush_callback<L, R, W, F, C, T, H>(
    transform: &JsTransform<L, R, W, F, C, T, H>,
) -> Option<H>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    transform.with(|data| data.flush_callback.clone())
}

pub fn transform_set_flush_callback<L, R, W, F, C, T, H>(
    transform: &JsTransform<L, R, W, F, C, T, H>,
    callback: H,
) where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    transform.with_mut(|data| data.flush_callback = Some(callback));
}

pub fn transform_is_passthrough<L, R, W, F, C, T, H>(
    transform: &JsTransform<L, R, W, F, C, T, H>,
) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    transform.with(|data| data.passthrough)
}

pub fn transform_ptr_eq<L, R, W, F, C, T, H>(
    left: &JsTransform<L, R, W, F, C, T, H>,
    right: &JsTransform<L, R, W, F, C, T, H>,
) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    left.ptr_eq(right)
}

pub fn transform_trace<L, R, W, F, C, T, H>(
    transform: &JsTransform<L, R, W, F, C, T, H>,
    tracer: &mut Tracer<'_>,
) where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
    T: Clone + Trace + 'static,
    H: Clone + Trace + 'static,
{
    tracer.edge(transform);
}
