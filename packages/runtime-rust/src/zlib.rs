use flate2::{Compress, Compression, Crc, Decompress, FlushCompress, FlushDecompress, Status};

/// Node's zlib error codes: a corrupt stream is Z_DATA_ERROR, one that ends
/// before its stream does is Z_BUF_ERROR (`err.code` on the thrown Error).
const ZLIB_DATA_ERROR: &str = "Z_DATA_ERROR";
const ZLIB_BUF_ERROR: &str = "Z_BUF_ERROR";

/// Compress bytes with Node's default zlib wrapper and compression level.
pub fn zlib_deflate_sync(input: &JsBytes<u8>) -> JsBytes<u8> {
    bytes_from_elements(zlib_compress_bytes(&bytes_u8_values(input), true))
}

/// deflateRawSync: the same DEFLATE stream with no zlib wrapper.
pub fn zlib_deflate_raw_sync(input: &JsBytes<u8>) -> JsBytes<u8> {
    bytes_from_elements(zlib_compress_bytes(&bytes_u8_values(input), false))
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
    let source = bytes_u8_values(input);
    let mut output = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3];
    output.extend_from_slice(&zlib_compress_bytes(&source, false));
    let mut crc = Crc::new();
    crc.update(&source);
    output.extend_from_slice(&crc.sum().to_le_bytes());
    output.extend_from_slice(&(source.len() as u32).to_le_bytes());
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

/// The shared one-shot deflate loop: Node's default compression level, with
/// or without the zlib wrapper. Compression of valid input cannot fail.
fn zlib_compress_bytes(source: &[u8], zlib_header: bool) -> Vec<u8> {
    let mut compressor = Compress::new(Compression::default(), zlib_header);
    let mut output = Vec::new();
    let mut consumed = 0;
    loop {
        output.reserve(32 * 1024);
        let input_before = compressor.total_in();
        let output_before = compressor.total_out();
        let status = compressor
            .compress_vec(&source[consumed..], &mut output, FlushCompress::Finish)
            .expect("scriptc: zlib deflate failed");
        consumed += (compressor.total_in() - input_before) as usize;
        if status == Status::StreamEnd {
            return output;
        }
        assert!(
            compressor.total_in() != input_before || compressor.total_out() != output_before,
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
    match source.get(offset..).unwrap_or(&[]).iter().position(|&b| b == 0) {
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
