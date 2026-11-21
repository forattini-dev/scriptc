fn native_file_write_stream_value(path: runtime::JsString, options: NativeValue) -> NativeValue {
    // Node defaults to flags: 'w'; a string argument is only the encoding.
    let flags = match options {
        NativeValue::Undefined | NativeValue::Null | NativeValue::String(_) => NativeValue::Undefined,
        options => native_value_get(options, runtime::string("flags")),
    };
    if !matches!(flags, NativeValue::Undefined)
        && !matches!(flags, NativeValue::String(ref value) if value == "w")
    {
        runtime::throw_error_code("scriptc: createWriteStream currently requires flags: 'w'".into(), "SC1031");
    }
    let writer = runtime::file_writer_new(&path);
    NativeValue::Object(runtime::Gc::new(NativeMap {
        null_prototype: false,
        symbol_properties: None,
        entries: vec![
            (runtime::string("write"), NativeValue::FileWriteStreamMethod(writer.clone(), 0)),
            (runtime::string("end"), NativeValue::FileWriteStreamMethod(writer.clone(), 1)),
            (runtime::string("on"), NativeValue::FileWriteStreamMethod(writer.clone(), 2)),
            (runtime::string("once"), NativeValue::FileWriteStreamMethod(writer, 3)),
        ],
        hash_index: NativeHashIndex::default(),
    }))
}

fn native_file_write_stream_call(
    writer: runtime::JsChildWriter,
    method: u8,
    receiver: NativeValue,
    args: Vec<NativeValue>,
) -> NativeValue {
    match method {
        0 => {
            let chunk = args.first().cloned().unwrap_or(NativeValue::Undefined);
            NativeValue::Boolean(runtime::child_writer_write_bytes(&writer, &native_file_write_stream_chunk(chunk)))
        }
        1 => {
            // `end(chunk[, encoding][, callback])` writes the final chunk first.
            if let Some(chunk) = args.first().cloned().filter(|value| {
                !native_value_is_function(value) && !matches!(value, NativeValue::Undefined | NativeValue::Null)
            }) {
                runtime::child_writer_write_bytes(&writer, &native_file_write_stream_chunk(chunk));
            }
            if let Some(callback) = args.iter().cloned().find(native_value_is_function) {
                let traced = callback.clone();
                runtime::child_writer_on_finish(
                    &writer,
                    std::rc::Rc::new(move || {
                        let _ = native_value_call(callback.clone(), Vec::new(), "WriteStream.end callback");
                    }),
                    std::rc::Rc::new(move |tracer| traced.trace_native(tracer)),
                    true,
                );
            }
            runtime::child_writer_end(&writer);
            receiver
        }
        2 | 3 => {
            let event = args.first().cloned().map(native_value_string).unwrap_or_else(|| runtime::string("undefined"));
            let callback = args.get(1).cloned().unwrap_or(NativeValue::Undefined);
            if !native_value_is_function(&callback) {
                runtime::throw_type_error("WriteStream listener must be a function".into());
            }
            let traced = callback.clone();
            match event.well_formed_utf8().unwrap_or("") {
                "drain" => runtime::child_writer_on_drain(
                    &writer,
                    std::rc::Rc::new(move || {
                        let _ = native_value_call(callback.clone(), Vec::new(), "WriteStream.drain listener");
                    }),
                    std::rc::Rc::new(move |tracer| traced.trace_native(tracer)),
                    method == 3,
                ),
                "error" => runtime::child_writer_on_error(
                    &writer,
                    std::rc::Rc::new(move |error| {
                        let _ = native_value_call(callback.clone(), vec![native_caught(runtime::caught_value(error))], "WriteStream.error listener");
                    }),
                    std::rc::Rc::new(move |tracer| traced.trace_native(tracer)),
                    method == 3,
                ),
                _ => runtime::throw_error_code("scriptc: WriteStream event is not ported".into(), "SC1031"),
            }
            receiver
        }
        _ => unreachable!("validated WriteStream method"),
    }
}

/// A `string` chunk is written as UTF-8 (the default encoding); bytes as-is.
fn native_file_write_stream_chunk(chunk: NativeValue) -> runtime::JsBytes<u8> {
    if let NativeValue::String(text) = &chunk {
        return runtime::buffer_from_string(text, &runtime::string("utf8"));
    }
    native_file_handle_bytes(chunk).unwrap_or_else(|| {
        runtime::throw_type_error(
            "The \"chunk\" argument must be of type string or an instance of Buffer or Uint8Array".into(),
        )
    })
}
