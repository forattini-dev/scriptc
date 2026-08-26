pub struct DuplexData<L, R, W, F, C>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    readable: Option<JsReadable<L, R>>,
    writable: Option<JsWritable<L, W, F, C>>,
    allow_half_open: bool,
    closed: bool,
}

impl<L, R, W, F, C> Trace for DuplexData<L, R, W, F, C>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    fn trace(&self, tracer: &mut Tracer<'_>) {
        if let Some(readable) = &self.readable {
            tracer.edge(readable);
        }
        if let Some(writable) = &self.writable {
            tracer.edge(writable);
        }
    }
}

impl<L, R, W, F, C> ClearEdges for DuplexData<L, R, W, F, C>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    fn clear_edges(&mut self) {
        self.readable = None;
        self.writable = None;
    }
}

pub type JsDuplex<L, R, W, F, C> = Gc<DuplexData<L, R, W, F, C>>;

pub fn duplex_new<L, R, W, F, C>(
    readable: JsReadable<L, R>,
    writable: JsWritable<L, W, F, C>,
    allow_half_open: bool,
) -> JsDuplex<L, R, W, F, C>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    Gc::new(DuplexData {
        readable: Some(readable),
        writable: Some(writable),
        allow_half_open,
        closed: false,
    })
}

pub fn duplex_readable<L, R, W, F, C>(
    duplex: &JsDuplex<L, R, W, F, C>,
) -> JsReadable<L, R>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    duplex.with(|data| {
        data.readable
            .as_ref()
            .expect("scriptc: cleared live Duplex readable half")
            .clone()
    })
}

pub fn duplex_writable<L, R, W, F, C>(
    duplex: &JsDuplex<L, R, W, F, C>,
) -> JsWritable<L, W, F, C>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    duplex.with(|data| {
        data.writable
            .as_ref()
            .expect("scriptc: cleared live Duplex writable half")
            .clone()
    })
}

pub fn duplex_emitter<L, R, W, F, C>(duplex: &JsDuplex<L, R, W, F, C>) -> JsEventEmitter<L>
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    readable_emitter(&duplex_readable(duplex))
}

pub fn duplex_trace<L, R, W, F, C>(
    duplex: &JsDuplex<L, R, W, F, C>,
    tracer: &mut Tracer<'_>,
) where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    tracer.edge(duplex);
}

pub fn duplex_ptr_eq<L, R, W, F, C>(
    left: &JsDuplex<L, R, W, F, C>,
    right: &JsDuplex<L, R, W, F, C>,
) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    left.ptr_eq(right)
}

pub fn duplex_allow_half_open<L, R, W, F, C>(duplex: &JsDuplex<L, R, W, F, C>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    duplex.with(|data| data.allow_half_open)
}

pub fn duplex_take_close<L, R, W, F, C>(duplex: &JsDuplex<L, R, W, F, C>) -> bool
where
    L: Clone + Trace + 'static,
    R: Clone + Trace + 'static,
    W: Clone + Trace + 'static,
    F: Clone + Trace + 'static,
    C: Clone + Trace + 'static,
{
    let readable = duplex_readable(duplex);
    let writable = duplex_writable(duplex);
    if readable_prop(&readable, &string("readableEnded")) == 0.0
        || !writable_bool_prop(&writable, &string("writableFinished"))
    {
        return false;
    }
    duplex.with_mut(|data| {
        if data.closed {
            return false;
        }
        data.closed = true;
        true
    })
}
