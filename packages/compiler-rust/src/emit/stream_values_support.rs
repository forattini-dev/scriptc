struct NativeStreamPipelineFrame {
    reader: Option<runtime::JsWebReader<runtime::JsBytes<u8>>>,
    destination: Option<NativeValue>,
    callback: Option<NativeValue>,
}

impl runtime::Trace for NativeStreamPipelineFrame {
    fn trace(&self, tracer: &mut runtime::Tracer<'_>) {
        if let Some(reader) = &self.reader {
            tracer.edge(reader);
        }
        if let Some(destination) = &self.destination {
            destination.trace_native(tracer);
        }
        if let Some(callback) = &self.callback {
            callback.trace_native(tracer);
        }
    }
}

impl runtime::ClearEdges for NativeStreamPipelineFrame {
    fn clear_edges(&mut self) {
        self.reader = None;
        self.destination = None;
        self.callback = None;
    }
}

fn native_stream_pipeline_finish(
    frame: runtime::Gc<NativeStreamPipelineFrame>,
    failure: Option<runtime::Caught>,
) {
    let (reader, callback) = frame.with_mut(|state| {
        (
            state.reader.take(),
            state.callback.take().unwrap_or(NativeValue::Undefined),
        )
    });
    if let Some(reader) = reader {
        runtime::web_reader_release(&reader);
    }
    frame.with_mut(|state| state.destination = None);
    let argument = failure.map(native_caught).unwrap_or(NativeValue::Undefined);
    let _ = native_value_call(callback, vec![argument], "stream.pipeline callback");
}

fn native_stream_pipeline_written(
    frame: runtime::Gc<NativeStreamPipelineFrame>,
    outcome: Result<NativeValue, runtime::Caught>,
) {
    match outcome {
        Ok(_) => native_stream_pipeline_read(frame),
        Err(reason) => native_stream_pipeline_finish(frame, Some(reason)),
    }
}

fn native_stream_pipeline_chunk(
    frame: runtime::Gc<NativeStreamPipelineFrame>,
    outcome: Result<Option<runtime::JsBytes<u8>>, runtime::Caught>,
) {
    let chunk = match outcome {
        Ok(Some(chunk)) => chunk,
        Ok(None) => {
            native_stream_pipeline_finish(frame, None);
            return;
        }
        Err(reason) => {
            native_stream_pipeline_finish(frame, Some(reason));
            return;
        }
    };
    let destination = frame.with(|state| {
        state
            .destination
            .as_ref()
            .expect("scriptc: cleared stream.pipeline destination")
            .clone()
    });
    let completion = runtime::promise_new();
    let callback = NativeValue::PromisifyCallback(completion.clone());
    let transformed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let transform = native_value_get(destination.clone(), runtime::string("_transform"));
        native_value_call_with_this(
            transform,
            destination,
            vec![
                native_box_web_bytes(chunk),
                NativeValue::String(runtime::string("buffer")),
                callback,
            ],
            "stream.pipeline _transform",
        )
    }));
    if let Err(payload) = transformed {
        native_stream_pipeline_finish(frame, Some(runtime::caught_from_panic(payload)));
        return;
    }
    runtime::promise_then_traced(&completion, frame, native_stream_pipeline_written);
}

fn native_stream_pipeline_read(frame: runtime::Gc<NativeStreamPipelineFrame>) {
    let reader = frame.with(|state| {
        state
            .reader
            .as_ref()
            .expect("scriptc: cleared stream.pipeline reader")
            .clone()
    });
    let next = runtime::web_reader_read(&reader);
    runtime::promise_then_traced(&next, frame, native_stream_pipeline_chunk);
}

fn native_stream_pipeline(
    source: NativeValue,
    destination: NativeValue,
    callback: NativeValue,
) -> NativeValue {
    if !native_value_is_function(&callback) {
        runtime::throw_type_error("stream.pipeline callback must be a function".into());
    }
    let NativeValue::WebBytesStream(stream) = source else {
        runtime::throw_type_error(
            "stream.pipeline source must be a native byte ReadableStream".into(),
        );
    };
    let reader = runtime::web_stream_get_reader(&stream);
    let result = destination.clone();
    let frame = runtime::Gc::new(NativeStreamPipelineFrame {
        reader: Some(reader),
        destination: Some(destination),
        callback: Some(callback),
    });
    native_stream_pipeline_read(frame);
    result
}
