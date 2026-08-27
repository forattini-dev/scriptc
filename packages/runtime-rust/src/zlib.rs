use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

/// Compress bytes with Node's default zlib wrapper and compression level.
pub fn zlib_deflate_sync(input: &JsBytes<u8>) -> JsBytes<u8> {
    let source = bytes_u8_values(input);
    let mut compressor = Compress::new(Compression::default(), true);
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
            return bytes_from_elements(output);
        }
        assert!(
            compressor.total_in() != input_before || compressor.total_out() != output_before,
            "scriptc: zlib deflate made no progress",
        );
    }
}

/// Inflate bytes carrying a zlib wrapper. Invalid input throws a catchable
/// JavaScript Error using Node's observable messages for the supported
/// header-corruption and truncated-stream cases.
pub fn zlib_inflate_sync(input: &JsBytes<u8>) -> JsBytes<u8> {
    let source = bytes_u8_values(input);
    if !has_zlib_header(&source) {
        throw_error("incorrect header check".to_owned());
    }

    let mut decompressor = Decompress::new(true);
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
        let status = decompressor.decompress_vec(
            &source[consumed..],
            &mut output,
            flush,
        );
        consumed += (decompressor.total_in() - input_before) as usize;
        match status {
            Ok(Status::StreamEnd) => return bytes_from_elements(output),
            Ok(Status::Ok | Status::BufError)
                if decompressor.total_in() != input_before
                    || decompressor.total_out() != output_before => {}
            Ok(Status::Ok | Status::BufError) if consumed == source.len() => {
                throw_error("unexpected end of file".to_owned());
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
                throw_error(message.to_owned());
            }
        }
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
