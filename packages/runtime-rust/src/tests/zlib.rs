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
}
