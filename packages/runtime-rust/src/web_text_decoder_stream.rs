// TextDecoderStream is a demand-driven UTF-8 view over a byte stream. Empty
// incremental decoder outputs are skipped so a split code point does not
// become an observable empty chunk.
struct TextDecoderWebSource {
    reader: JsWebReader<JsBytes<u8>>,
    decoder: f64,
}

impl Trace for TextDecoderWebSource {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        tracer.edge(&self.reader);
    }
}

fn web_text_decode_next(
    reader: JsWebReader<JsBytes<u8>>,
    stream: JsWebStream<JsString>,
    decoder: f64,
    result: JsPromise<JsString>,
) {
    let read = web_reader_read(&reader);
    promise_then(&read, Box::new(move |outcome| match outcome {
        Ok(Some(bytes)) => {
            let text = text_decode_stream(decoder, &bytes, true, false);
            if text.as_ref().is_empty() {
                web_text_decode_next(reader, stream, decoder, result);
            } else {
                web_stream_enqueue(&stream, text.clone());
                let _ = promise_fulfill(&result, text);
            }
        }
        Ok(None) => {
            let tail = text_decode_stream(decoder, &bytes_empty::<u8>(), false, false);
            if !tail.as_ref().is_empty() {
                web_stream_enqueue(&stream, tail);
            }
            web_reader_release(&reader);
            web_stream_close(&stream);
            let _ = promise_fulfill(&result, string(""));
        }
        Err(error) => {
            let _ = promise_reject(&result, error);
        }
    }));
}

impl WebStreamSource<JsString> for TextDecoderWebSource {
    fn has_pull(&self) -> bool { true }

    fn pull(&self, stream: &JsWebStream<JsString>) -> JsPromise<JsString> {
        let result = promise_new();
        web_text_decode_next(self.reader.clone(), stream.clone(), self.decoder, result.clone());
        result
    }

    fn cancel(&self, _: JsString) -> JsPromise<JsString> {
        promise_map(
            &web_reader_cancel(&self.reader, bytes_empty::<u8>()),
            |_| string(""),
        )
    }
}

pub fn web_text_decoder_stream(
    source: &JsWebStream<JsBytes<u8>>,
    decoder: f64,
) -> JsWebStream<JsString> {
    let start = promise_resolved(string(""));
    let stream = web_stream_new_with_prefetch(
        Rc::new(TextDecoderWebSource {
            reader: web_stream_get_reader(source),
            decoder,
        }),
        false,
    );
    web_stream_start(&stream, &start);
    stream
}
