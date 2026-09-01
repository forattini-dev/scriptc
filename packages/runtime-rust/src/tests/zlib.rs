#[test]
fn zlib_round_trip_crosses_internal_buffer_boundaries() {
    let mut state = 0x1234_5678_u32;
    let source: Vec<u8> = (0..100_000)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect();
    let input = bytes_from_elements(source.clone());
    let compressed = zlib_deflate_sync(&input);
    assert!(bytes_u8_values(&compressed).len() > 32 * 1024);
    let restored = zlib_inflate_sync(&compressed);
    assert_eq!(bytes_u8_values(&restored), source);

    // The gzip framing carries the same payload across those boundaries.
    let zipped = zlib_gzip_sync(&input);
    assert_eq!(bytes_u8_values(&zlib_gunzip_sync(&zipped)), source);
    assert_eq!(bytes_u8_values(&zlib_unzip_sync(&zipped)), source);
}

/// A gzip stream Node produced: the header bytes scriptc writes, and the
/// payload every gzip decoder agrees on.
#[test]
fn gzip_matches_node_framing() {
    let text = b"hello hello hello hello compression works";
    let zipped = bytes_u8_values(&zlib_gzip_sync(&bytes_from_elements(text.to_vec())));
    assert_eq!(&zipped[..10], &[0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
    // CRC32 and ISIZE little-endian, exactly Node's trailer for this input.
    assert_eq!(&zipped[zipped.len() - 8..], &[0x12, 0xce, 0x94, 0xd8, 41, 0, 0, 0]);

    let from_node = hex_bytes(
        "1f8b0800000000000003cb48cdc9c957c8c02093f3730b8a528b8b33f3f314caf38bb28b0112ce94d829000000",
    );
    assert_eq!(bytes_u8_values(&zlib_gunzip_sync(&from_node)), text);
    assert_eq!(bytes_u8_values(&zlib_unzip_sync(&from_node)), text);
}

/// unzipSync sniffs the header: gzip magic, a zlib wrapper, and the raw
/// pair that carries neither.
#[test]
fn unzip_reads_both_wrappers_and_raw_round_trips() {
    let text = b"the quick brown fox jumps over the lazy dog";
    let input = bytes_from_elements(text.to_vec());
    let deflated = zlib_deflate_sync(&input);
    assert_eq!(bytes_u8_values(&zlib_unzip_sync(&deflated)), text);

    let raw = zlib_deflate_raw_sync(&input);
    assert_eq!(
        bytes_u8_values(&raw)[..2],
        bytes_u8_values(&deflated)[2..4],
        "raw output is the wrapped stream without its two header bytes",
    );
    assert_eq!(bytes_u8_values(&zlib_inflate_raw_sync(&raw)), text);
    let from_node = hex_bytes("cb48cdc9c957c8c02093f3730b8a528b8b33f3f314caf38bb28b01");
    assert_eq!(
        bytes_u8_values(&zlib_inflate_raw_sync(&from_node)),
        b"hello hello hello hello compression works",
    );

    // gzip's body is exactly that raw stream.
    let zipped = zlib_gzip_sync(&input);
    assert_eq!(
        &bytes_u8_values(&zipped)[10..bytes_u8_values(&zipped).len() - 8],
        bytes_u8_values(&raw),
    );
}

/// Empty payloads keep their wrappers and round-trip to nothing.
#[test]
fn empty_input_round_trips_through_every_wrapper() {
    let empty = bytes_from_elements(Vec::new());
    for zipped in [zlib_gzip_sync(&empty), zlib_deflate_sync(&empty)] {
        assert!(bytes_u8_values(&zipped).len() > 1);
        assert!(bytes_u8_values(&zlib_unzip_sync(&zipped)).is_empty());
    }
    assert!(bytes_u8_values(&zlib_gunzip_sync(&zlib_gzip_sync(&empty))).is_empty());
    assert!(bytes_u8_values(&zlib_inflate_raw_sync(&zlib_deflate_raw_sync(&empty))).is_empty());
}

fn hex_bytes(hex: &str) -> JsBytes<u8> {
    let digits: Vec<u8> = hex.as_bytes().to_vec();
    let values = digits
        .chunks(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("ascii hex"), 16)
                .expect("valid hex byte")
        })
        .collect();
    bytes_from_elements(values)
}
