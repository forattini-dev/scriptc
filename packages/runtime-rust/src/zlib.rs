use flate2::{Compress, Compression, Crc, Decompress, FlushCompress, FlushDecompress, Status};

/// Node's zlib error codes: a corrupt stream is Z_DATA_ERROR, one that ends
/// before its stream does is Z_BUF_ERROR (`err.code` on the thrown Error).
const ZLIB_DATA_ERROR: &str = "Z_DATA_ERROR";
const ZLIB_BUF_ERROR: &str = "Z_BUF_ERROR";

/// Compress bytes with Node's default zlib wrapper and compression level.
pub fn zlib_deflate_sync(input: &JsBytes<u8>) -> JsBytes<u8> {
    let output = zlib_with_input(input, |source| zlib_compress_bytes(source, true));
    bytes_from_elements(output)
}

/// A frontend-validated integer compression level.
pub fn zlib_deflate_sync_level(input: &JsBytes<u8>, level: f64) -> JsBytes<u8> {
    assert!(
        (-1.0..=9.0).contains(&level) && level.fract() == 0.0,
        "scriptc: invalid native deflate level"
    );
    let compression = if level == -1.0 {
        Compression::default()
    } else {
        Compression::new(level as u32)
    };
    let output = zlib_with_input(input, |source| {
        zlib_compress_bytes_level(source, true, compression)
    });
    bytes_from_elements(output)
}

/// deflateRawSync: the same DEFLATE stream with no zlib wrapper.
pub fn zlib_deflate_raw_sync(input: &JsBytes<u8>) -> JsBytes<u8> {
    let output = zlib_with_input(input, |source| zlib_compress_bytes(source, false));
    bytes_from_elements(output)
}

/// Inflate bytes carrying a zlib wrapper. Invalid input throws a catchable
/// JavaScript Error using Node's observable messages for the supported
/// header-corruption and truncated-stream cases.
pub fn zlib_inflate_sync(input: &JsBytes<u8>) -> JsBytes<u8> {
    let source = bytes_u8_values(input);
    // zlib reads the whole 16-bit header word before judging it: a source
    // too short to hold one ended early, it is not a bad header.
    if source.len() < 2 {
        throw_error_code("unexpected end of file".to_owned(), ZLIB_BUF_ERROR);
    }
    if !has_zlib_header(&source) {
        throw_error_code("incorrect header check".to_owned(), ZLIB_DATA_ERROR);
    }
    bytes_from_elements(zlib_decompress_bytes(&source, true).0)
}

/// inflateRawSync: a headerless DEFLATE stream (deflateRawSync's output).
pub fn zlib_inflate_raw_sync(input: &JsBytes<u8>) -> JsBytes<u8> {
    bytes_from_elements(zlib_decompress_bytes(&bytes_u8_values(input), false).0)
}

/// gzipSync: raw DEFLATE inside Node's gzip framing — the 10-byte header
/// zlib itself writes at the default level (no name, no extra fields, an
/// unset mtime, OS 3), then the CRC32 and the input length.
pub fn zlib_gzip_sync(input: &JsBytes<u8>) -> JsBytes<u8> {
    let output = zlib_with_input(input, |source| {
        let mut output = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3];
        output.extend_from_slice(&zlib_compress_bytes(source, false));
        let mut crc = Crc::new();
        crc.update(source);
        output.extend_from_slice(&crc.sum().to_le_bytes());
        output.extend_from_slice(&(source.len() as u32).to_le_bytes());
        output
    });
    bytes_from_elements(output)
}

/// gunzipSync: the gzip member's header, body, and trailer checks. Every
/// rejection carries the message and code Node's zlib reports. Like the C
/// lane (zlib's own one-shot inflate) this decodes the FIRST member and
/// ignores whatever follows it.
pub fn zlib_gunzip_sync(input: &JsBytes<u8>) -> JsBytes<u8> {
    bytes_from_elements(gunzip_member(&bytes_u8_values(input)))
}

/// unzipSync: Node's auto-detecting decompressor — the gzip magic picks the
/// gzip path, a valid zlib header the zlib path, anything else is the
/// header-check rejection zlib's windowBits+32 mode reports.
pub fn zlib_unzip_sync(input: &JsBytes<u8>) -> JsBytes<u8> {
    let source = bytes_u8_values(input);
    if source.len() < 2 {
        throw_error_code("unexpected end of file".to_owned(), ZLIB_BUF_ERROR);
    }
    if source[0] == 0x1f && source[1] == 0x8b {
        return bytes_from_elements(gunzip_member(&source));
    }
    if !has_zlib_header(&source) {
        throw_error_code("incorrect header check".to_owned(), ZLIB_DATA_ERROR);
    }
    bytes_from_elements(zlib_decompress_bytes(&source, true).0)
}

/// Node's zlib.crc32(data[, value]). The supplied value is the previous
/// finalized CRC, so resume by complementing it before and after the update.
pub fn zlib_crc32(input: &JsBytes<u8>, value: f64) -> f64 {
    if !value.is_finite() || value.trunc() != value {
        throw_range_error_code(
            format!(
                "The value of \"value\" is out of range. It must be an integer. Received {}",
                format_number(value)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    if !(0.0..=4_294_967_295.0).contains(&value) {
        throw_range_error_code(
            format!(
                "The value of \"value\" is out of range. It must be >= 0 && <= 4294967295. Received {}",
                format_number(value)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    let mut crc = (value as u32) ^ u32::MAX;
    zlib_with_input(input, |source| {
        for byte in source {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb8_8320 & 0_u32.wrapping_sub(crc & 1));
            }
        }
    });
    (crc ^ u32::MAX) as f64
}

/// Schedule a default-options codec on the next loop turn. Runtime handles,
/// exception slots, and callback execution stay on the owning thread.
type ZlibCodecCallback = Box<dyn FnOnce(Option<JsError>, Option<JsBytes<u8>>)>;

/// Promise projection of the existing error-first raw codec. Scheduling and
/// buffer ownership stay identical to the callback path on the owning thread.
pub fn zlib_raw_promise(input: &JsBytes<u8>, compressing: bool) -> JsPromise<JsBytes<u8>> {
    let promise = promise_new();
    let guard = promise.clone();
    promise_run_segment(&guard, || {
        zlib_raw_promise_start(&promise, input, compressing, -1.0)
    });
    promise
}

/// Called inside a promise segment: option-validation throws become rejections,
/// and successful codecs retain the error-first path's deferred completion.
pub fn zlib_raw_promise_start(
    promise: &JsPromise<JsBytes<u8>>,
    input: &JsBytes<u8>,
    compressing: bool,
    level: f64,
) {
    let compression = zlib_raw_compression_level(level);
    let target = promise.clone();
    zlib_codec_async_level(
        input,
        1,
        compressing,
        compression,
        Box::new(move |error, value| {
            if let Some(error) = error {
                let _ = promise_reject(&target, caught_value(error));
            } else {
                let _ = promise_fulfill(
                    &target,
                    value.expect("scriptc: zlib success without a Buffer"),
                );
            }
        }),
    );
}

fn zlib_raw_compression_level(level: f64) -> Compression {
    if level.is_nan() || level == -1.0 {
        return Compression::default();
    }
    if !level.is_finite() {
        throw_range_error_code(
            format!(
                "The value of \"options.level\" is out of range. It must be a finite number. Received {}",
                format_number(level)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    if !(-1.0..=9.0).contains(&level) {
        throw_range_error_code(
            format!(
                "The value of \"options.level\" is out of range. It must be >= -1 and <= 9. Received {}",
                format_number(level)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    Compression::new(level as u32)
}

pub fn zlib_codec_async(
    input: &JsBytes<u8>,
    mode: u8,
    compressing: bool,
    callback: ZlibCodecCallback,
) {
    zlib_codec_async_level(input, mode, compressing, Compression::default(), callback);
}

fn zlib_codec_async_level(
    input: &JsBytes<u8>,
    mode: u8,
    compressing: bool,
    level: Compression,
    callback: ZlibCodecCallback,
) {
    let input = input.clone();
    process_next_tick(Box::new(move || {
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match (mode, compressing) {
                (0, true) => zlib_deflate_sync(&input),
                (0, false) => zlib_inflate_sync(&input),
                (1, true) => bytes_from_elements(zlib_with_input(&input, |source| {
                    zlib_compress_bytes_level(source, false, level)
                })),
                (1, false) => zlib_inflate_raw_sync(&input),
                (2, true) => zlib_gzip_sync(&input),
                (2, false) => zlib_gunzip_sync(&input),
                (3, false) => zlib_unzip_sync(&input),
                _ => unreachable!("scriptc invariant: invalid zlib codec mode"),
            }));
        match outcome {
            Ok(value) => callback(None, Some(value)),
            Err(payload) => {
                let caught = caught_from_panic(payload);
                callback(Some(caught_error_value(&caught)), None);
            }
        }
    }));
}

/// The shared one-shot deflate loop: Node's default compression level, with
/// or without the zlib wrapper. Compression of valid input cannot fail.
fn zlib_compress_bytes(source: &[u8], zlib_header: bool) -> Vec<u8> {
    zlib_compress_bytes_level(source, zlib_header, Compression::default())
}

/// Node hands zlib one `Z_DEFAULT_CHUNK` (16 KiB) output buffer per call and
/// loops while it comes back full. Stored blocks are cut against the output
/// space available, so the block layout of `{ level: 0 }` (and the stored
/// fallback inside any level) only matches Node when the compressor sees the
/// same buffer size.
const NODE_ZLIB_CHUNK: usize = 16 * 1024;

fn zlib_compress_bytes_level(source: &[u8], zlib_header: bool, level: Compression) -> Vec<u8> {
    let mut compressor = Compress::new(level, zlib_header);
    let mut output = Vec::new();
    let mut chunk = vec![0_u8; NODE_ZLIB_CHUNK];
    let mut consumed = 0;
    loop {
        let input_before = compressor.total_in();
        let output_before = compressor.total_out();
        let status = compressor
            .compress(&source[consumed..], &mut chunk, FlushCompress::Finish)
            .expect("scriptc: zlib deflate failed");
        consumed += (compressor.total_in() - input_before) as usize;
        let produced = (compressor.total_out() - output_before) as usize;
        output.extend_from_slice(&chunk[..produced]);
        if status == Status::StreamEnd {
            return output;
        }
        assert!(
            compressor.total_in() != input_before || produced != 0,
            "scriptc: zlib deflate made no progress",
        );
    }
}

/// The shared one-shot inflate loop. Returns the inflated bytes and how many
/// input bytes the stream itself consumed — the gzip framing reads its
/// trailer from exactly there. Corrupt or truncated input throws.
fn zlib_decompress_bytes(source: &[u8], zlib_header: bool) -> (Vec<u8>, usize) {
    let mut decompressor = Decompress::new(zlib_header);
    let mut output = Vec::new();
    let mut consumed = 0;
    loop {
        output.reserve(32 * 1024);
        let input_before = decompressor.total_in();
        let output_before = decompressor.total_out();
        let flush = if consumed < source.len() {
            FlushDecompress::None
        } else {
            FlushDecompress::Finish
        };
        let status = decompressor.decompress_vec(&source[consumed..], &mut output, flush);
        consumed += (decompressor.total_in() - input_before) as usize;
        match status {
            Ok(Status::StreamEnd) => return (output, consumed),
            Ok(Status::Ok | Status::BufError)
                if decompressor.total_in() != input_before
                    || decompressor.total_out() != output_before => {}
            Ok(Status::Ok | Status::BufError) if consumed == source.len() => {
                throw_error_code("unexpected end of file".to_owned(), ZLIB_BUF_ERROR);
            }
            Ok(Status::Ok | Status::BufError) => {
                unreachable!("scriptc: zlib inflate made no progress with input remaining")
            }
            Err(error) => {
                let message = match error.message() {
                    Some("Adler32 checksum mismatch") => "incorrect data check",
                    Some(message) => message,
                    None => "invalid compressed data",
                };
                throw_error_code(message.to_owned(), ZLIB_DATA_ERROR);
            }
        }
    }
}

/// Decode one gzip member: header, raw-DEFLATE body, CRC32 and length
/// trailer. The rejections mirror zlib's inflate state machine, which is
/// what Node reports.
fn gunzip_member(source: &[u8]) -> Vec<u8> {
    let body = gzip_body_offset(source);
    let (output, consumed) = zlib_decompress_bytes(&source[body..], false);
    let trailer = gzip_field(source, body + consumed, 8);
    let mut crc = Crc::new();
    crc.update(&output);
    if u32::from_le_bytes([trailer[0], trailer[1], trailer[2], trailer[3]]) != crc.sum() {
        throw_error_code("incorrect data check".to_owned(), ZLIB_DATA_ERROR);
    }
    let length = u32::from_le_bytes([trailer[4], trailer[5], trailer[6], trailer[7]]);
    if length != output.len() as u32 {
        throw_error_code("incorrect length check".to_owned(), ZLIB_DATA_ERROR);
    }
    output
}

/// Validate the gzip header and answer where the DEFLATE body starts.
fn gzip_body_offset(source: &[u8]) -> usize {
    let magic = gzip_field(source, 0, 2);
    if magic != [0x1f, 0x8b] {
        throw_error_code("incorrect header check".to_owned(), ZLIB_DATA_ERROR);
    }
    let method_and_flags = gzip_field(source, 2, 2);
    if method_and_flags[0] != 8 {
        throw_error_code("unknown compression method".to_owned(), ZLIB_DATA_ERROR);
    }
    let flags = method_and_flags[1];
    if flags & 0xe0 != 0 {
        throw_error_code("unknown header flags set".to_owned(), ZLIB_DATA_ERROR);
    }
    // MTIME, XFL and OS complete the fixed header; the optional fields
    // follow in zlib's order: extra, name, comment, header CRC.
    gzip_field(source, 4, 6);
    let mut offset = 10;
    if flags & 0x04 != 0 {
        let extra = gzip_field(source, offset, 2);
        let length = usize::from(u16::from_le_bytes([extra[0], extra[1]]));
        gzip_field(source, offset + 2, length);
        offset += 2 + length;
    }
    for field in [0x08, 0x10] {
        if flags & field != 0 {
            offset += gzip_terminated_field(source, offset);
        }
    }
    if flags & 0x02 != 0 {
        let stored = gzip_field(source, offset, 2);
        let expected = u16::from_le_bytes([stored[0], stored[1]]);
        let mut crc = Crc::new();
        crc.update(&source[..offset]);
        if expected != crc.sum() as u16 {
            throw_error_code("header crc mismatch".to_owned(), ZLIB_DATA_ERROR);
        }
        offset += 2;
    }
    offset
}

/// A fixed-width gzip header/trailer field. Running out of input mid-field
/// is Node's truncated-stream rejection, never a header-check failure.
fn gzip_field(source: &[u8], offset: usize, length: usize) -> &[u8] {
    match source.get(offset..offset + length) {
        Some(field) => field,
        None => throw_error_code("unexpected end of file".to_owned(), ZLIB_BUF_ERROR),
    }
}

/// A NUL-terminated gzip header string (FNAME/FCOMMENT); answers the bytes
/// it occupies, terminator included.
fn gzip_terminated_field(source: &[u8], offset: usize) -> usize {
    match source
        .get(offset..)
        .unwrap_or(&[])
        .iter()
        .position(|&b| b == 0)
    {
        Some(end) => end + 1,
        None => throw_error_code("unexpected end of file".to_owned(), ZLIB_BUF_ERROR),
    }
}

fn has_zlib_header(input: &[u8]) -> bool {
    let Some((&method, rest)) = input.split_first() else {
        return false;
    };
    let Some(&flags) = rest.first() else {
        return false;
    };
    method & 0x0f == 8 && method >> 4 <= 7 && (u16::from(method) << 8 | u16::from(flags)) % 31 == 0
}

/// Compression is synchronous and cannot call JS or mutate the input. Borrow
/// direct storage, including offset views; preserve materialization for views
/// backed by other element types. Callers create the GC result after this scope.
fn zlib_with_input<R>(input: &JsBytes<u8>, body: impl FnOnce(&[u8]) -> R) -> R {
    bytes_with_read_slice(input, |source| match source {
        Some(source) => body(source),
        None => body(&bytes_u8_values(input)),
    })
}

#[cfg(test)]
#[path = "zlib.test.rs"]
mod zlib_input_tests;
