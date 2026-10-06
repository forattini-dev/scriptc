use super::*;

#[test]
fn level_six_discards_distant_three_byte_matches_at_the_node_boundary() {
    for (distance, expected) in [
        (
            4095,
            "edd7010d0020080030409cc50dae3386fb5b7c668d5e010000007cecf67fbffe1f",
        ),
        (
            4096,
            "edd7010d0020080030409cc50dae3386fb5b7c668d5e01000000fcecfe7fbfff1f",
        ),
        (
            4097,
            "edd809090020100030efc3e206178c215b8c4d64f55e000000c0d722ebbc00b8",
        ),
        (
            8192,
            "edd909090020100030efc3e206176c216c353691d57b01000000000000003f8bacf3feff02",
        ),
    ] {
        let mut source = vec![0_u8; distance + 10];
        source[0] = 5;
        source[1..6].copy_from_slice(&[1, 2, 3, 4, 7]);
        source[distance + 1..distance + 6].copy_from_slice(&[1, 2, 3, 132, 7]);
        let input = bytes_from_elements(source);
        assert_eq!(
            bytes_u8_values(&zlib_deflate_raw_sync(&input)),
            hex_bytes(expected),
            "distance {distance}"
        );
    }
}

#[test]
fn level_six_preserves_node_hash_chain_choices() {
    let input = bytes_from_elements(vec![
        0x82_u8, 0xf9, 0x04, 0x93, 0xd6, 0xf9, 0x04, 0x93, 0x56,
    ]);
    assert_eq!(
        bytes_u8_values(&zlib_deflate_raw_sync(&input)),
        vec![0x6b, 0xfa, 0xc9, 0x32, 0xf9, 0x1a, 0x10, 0x87, 0x01, 0x00]
    );
}

#[test]
fn level_six_preserves_a_repeated_three_byte_tail() {
    let input = bytes_from_elements(vec![2_u8, 0, 3, 2, 0, 3, 2]);
    assert_eq!(
        bytes_u8_values(&zlib_deflate_raw_sync(&input)),
        vec![0x63, 0x62, 0x60, 0x66, 0x02, 0x22, 0x00]
    );
}

#[test]
fn level_six_matches_node_without_changing_framing_or_numeric_level() {
    let input = bytes_from_elements("abc".repeat(89).into_bytes());
    let raw = vec![0x4b, 0x4c, 0x4a, 0x4e, 0x1c, 0x45, 0x60, 0x04, 0x00];
    // Literal vectors from Node 26.10.0 and Node 24.15.0, not another Rust codec.
    let wrapped = vec![
        0x78, 0x9c, 0x4b, 0x4c, 0x4a, 0x4e, 0x1c, 0x45, 0x60, 0x04, 0x00, 0x83, 0xb8, 0x66, 0x37,
    ];
    assert_eq!(bytes_u8_values(&zlib_deflate_raw_sync(&input)), raw);
    assert_eq!(bytes_u8_values(&zlib_deflate_sync(&input)), wrapped);
    assert_eq!(
        bytes_u8_values(&zlib_deflate_sync_level(&input, 6.0)),
        wrapped
    );
    assert_eq!(
        bytes_u8_values(&zlib_deflate_sync_level(&input, -1.0)),
        wrapped
    );
    assert_eq!(
        bytes_u8_values(&zlib_gzip_sync(&input)),
        vec![
            0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x4b, 0x4c, 0x4a, 0x4e,
            0x1c, 0x45, 0x60, 0x04, 0x00, 0x0f, 0x72, 0xec, 0x57, 0x0b, 0x01, 0x00, 0x00,
        ]
    );
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
        .collect()
}

/// A match-heavy deterministic input: random literals interleaved with copies
/// of 3..32 bytes from up to 40000 bytes back. The same generator ran under
/// Node to produce the length and CRC-32 literals below.
fn copy_heavy_input(length: usize) -> Vec<u8> {
    let mut state = 0x2545_f491_u32;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state
    };
    let mut data = vec![0_u8; length];
    let mut at = 0;
    while at < length {
        if at == 0 || next() % 5 == 0 {
            data[at] = next() as u8;
            at += 1;
        } else {
            let run = 3 + (next() % 30) as usize;
            let distance = 1 + (next() as usize % at.min(40000));
            for _ in 0..run {
                if at >= length {
                    break;
                }
                data[at] = data[at - distance];
                at += 1;
            }
        }
    }
    data
}

fn crc32_of(bytes: &[u8]) -> u32 {
    let mut crc = Crc::new();
    crc.update(bytes);
    crc.sum()
}

/// The payload length of each stored block in a zlib stream made only of
/// stored blocks.
fn stored_block_lengths(stream: &[u8]) -> Vec<usize> {
    let mut lengths = Vec::new();
    let mut at = 2;
    loop {
        let last = stream[at] & 1 == 1;
        assert_eq!(stream[at] >> 1, 0, "block at {at} is not stored");
        let length = usize::from(u16::from_le_bytes([stream[at + 1], stream[at + 2]]));
        lengths.push(length);
        at += 5 + length;
        if last {
            assert_eq!(stream.len(), at + 4, "adler trailer");
            return lengths;
        }
    }
}

#[test]
fn level_nine_reproduces_node_slow_matching_rules() {
    // Literal level-9 vectors from Node 26.8.1 and Node 24.15.0 (identical on
    // both). Each of the first three isolates one rule: a repeated three-byte
    // tail is inserted, the four-byte hash picks the chain, and the plain
    // chain walk (not upstream's rolling-hash jumper) picks the match.
    let distant = |distance: usize| {
        let mut source = vec![0_u8; distance + 10];
        source[0] = 5;
        source[1..6].copy_from_slice(&[1, 2, 3, 4, 7]);
        source[distance + 1..distance + 6].copy_from_slice(&[1, 2, 3, 132, 7]);
        source
    };
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "three-byte tail",
            vec![2, 0, 3, 2, 0, 3, 2],
            "78da636260660222000034000d",
        ),
        (
            "four-byte hash",
            vec![0x6c, 0x20, 0x66, 0x69, 0x20, 0x66, 0x69],
            "78dacb5148cb5448cb040008f2024b",
        ),
        (
            "chain walk",
            b"n tree tref tree".to_vec(),
            "78dacb5328294a4d051169601600310505e0",
        ),
        (
            "hash chain choice",
            vec![0x82, 0xf9, 0x04, 0x93, 0xd6, 0xf9, 0x04, 0x93, 0x56],
            "78da6bfac932f91a10870100198b04cf",
        ),
        (
            "abc x 89",
            "abc".repeat(89).into_bytes(),
            "78da4b4c4a4e1c4560040083b86637",
        ),
        (
            "distance 4095",
            distant(4095),
            "78daedd7010d0020080030409cc50dae3386fb5b7c668d5e010000007cecf67fbffe1f740600a8",
        ),
        (
            "distance 4096",
            distant(4096),
            "78daedd7010d0020080030409cc50dae3386fb5b7c668d5e01000000fcecfe7fbfff1f741d00a8",
        ),
        (
            "distance 4097",
            distant(4097),
            "78daedd809090020100030efc3e206178c215b8c4d64f55e000000c0d722ebbc00b8743400a8",
        ),
        (
            "distance 8192",
            distant(8192),
            "78daedd909090020100030efc3e206176c216c353691d57b01000000000000003f8bacf3feff02e42c00a8",
        ),
    ];
    for (name, source, expected) in cases {
        let input = bytes_from_elements(source);
        assert_eq!(
            bytes_u8_values(&zlib_deflate_sync_level(&input, 9.0)),
            hex_bytes(expected),
            "{name}"
        );
    }
}

#[test]
fn level_nine_matches_node_on_long_inputs_without_touching_other_levels() {
    // (level, input length, output length, output CRC-32) from Node 26.8.1 and
    // Node 24.15.0. Level 9 differs from level 6 here, so the pair also pins
    // that the level 9 configuration is not the level 6 one.
    for (level, length, out_length, out_crc) in [
        (6.0, 20_000, 3177, 3_823_972_929_u32),
        (9.0, 20_000, 2719, 3_693_016_765),
        (6.0, 300_000, 60_690, 630_995_340),
        (9.0, 300_000, 52_641, 3_720_074_659),
    ] {
        let input = bytes_from_elements(copy_heavy_input(length));
        let packed = bytes_u8_values(&zlib_deflate_sync_level(&input, level));
        assert_eq!(packed.len(), out_length, "level {level}, {length} bytes");
        assert_eq!(crc32_of(&packed), out_crc, "level {level}, {length} bytes");
        assert_eq!(
            bytes_u8_values(&zlib_inflate_sync(&bytes_from_elements(packed))),
            bytes_u8_values(&input)
        );
    }
}

#[test]
fn level_zero_cuts_stored_blocks_like_node() {
    // Block layouts measured under Node 26.8.1 and Node 24.15.0: the first
    // block fills the 64 KiB pending buffer less its header, later ones follow
    // the 16 KiB output chunk Node passes to every deflate call.
    for (length, blocks) in [
        (0, vec![0]),
        (16_384, vec![16_384]),
        (65_535, vec![65_531, 4]),
        (100_000, vec![65_531, 32_773, 1_696]),
        (200_000, vec![65_531, 32_773, 32_768, 32_768, 32_768, 3_392]),
    ] {
        let source = vec![7_u8; length];
        let input = bytes_from_elements(source.clone());
        let packed = bytes_u8_values(&zlib_deflate_sync_level(&input, 0.0));
        assert_eq!(stored_block_lengths(&packed), blocks, "{length} bytes");
        assert_eq!(
            bytes_u8_values(&zlib_inflate_sync(&bytes_from_elements(packed))),
            source
        );
    }
    let input = bytes_from_elements(copy_heavy_input(300_000));
    let packed = bytes_u8_values(&zlib_deflate_sync_level(&input, 0.0));
    assert_eq!(packed.len(), 300_051);
    assert_eq!(crc32_of(&packed), 2_224_156_836);
}

/// Four letters drawn from the same xorshift32 stream: the compressible,
/// match-dense shape that exposed the first-slide divergence.
fn alpha_four_input(length: usize) -> Vec<u8> {
    let mut state = 0x2545_f491_u32;
    (0..length)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            97 + (state & 3) as u8
        })
        .collect()
}

#[test]
fn levels_six_and_nine_match_node_when_the_first_window_slide_ends_the_stream() {
    // zlib slides the window once the position passes wsize + MAX_DIST (65274)
    // and moves only the bytes that hold data. An input that ends inside that
    // first slide leaves the bytes past the data in place, and the final
    // `longest_match` reads them. (generator, level, input length, output
    // length, output CRC-32) from Node 26.8.1 and Node 24.15.0, identical on
    // both. The first six sit in the affected range (the full-half copy gave
    // other bytes there); the rest are neighbours on either side of it and in
    // the second slide range.
    type Generator = fn(usize) -> Vec<u8>;
    type ZoneCase = (Generator, f64, usize, usize, u32);
    let alpha: Generator = alpha_four_input;
    let copy: Generator = copy_heavy_input;
    let cases: [ZoneCase; 14] = [
        (alpha, 9.0, 65_283, 19_639, 4_170_846_241),
        (alpha, 6.0, 65_283, 19_607, 539_588_531),
        (copy, 9.0, 65_296, 10_039, 470_470_147),
        (copy, 6.0, 65_296, 11_741, 3_135_187_304),
        (copy, 9.0, 65_355, 10_051, 2_599_927_170),
        (copy, 6.0, 65_355, 11_759, 2_720_624_212),
        (alpha, 9.0, 65_273, 19_635, 4_075_808_209),
        (alpha, 6.0, 65_273, 19_603, 1_377_524_771),
        (alpha, 9.0, 65_540, 19_711, 1_684_639_372),
        (alpha, 6.0, 65_540, 19_680, 3_252_598_065),
        (alpha, 9.0, 98_100, 29_125, 3_132_656_234),
        (alpha, 6.0, 98_100, 29_087, 665_049_235),
        (copy, 9.0, 98_100, 15_718, 3_323_190_691),
        (copy, 6.0, 98_100, 18_392, 815_150_518),
    ];
    for (generate, level, length, out_length, out_crc) in cases {
        let source = generate(length);
        let input = bytes_from_elements(source.clone());
        let packed = bytes_u8_values(&zlib_deflate_sync_level(&input, level));
        assert_eq!(packed.len(), out_length, "level {level}, {length} bytes");
        assert_eq!(crc32_of(&packed), out_crc, "level {level}, {length} bytes");
        if level == 6.0 {
            // The default level is level 6 and must take the same path.
            assert_eq!(
                bytes_u8_values(&zlib_deflate_sync(&input)),
                packed,
                "default level, {length} bytes"
            );
        }
        assert_eq!(
            bytes_u8_values(&zlib_inflate_sync(&bytes_from_elements(packed))),
            source
        );
    }
}

#[test]
fn direct_input_and_offset_views_are_borrowed() {
    let input = bytes_from_elements(vec![11_u8, 22, 33, 44, 55]);
    let view = bytes_slice(&input, 1.0, 4.0, true);
    for bytes in [&input, &view] {
        bytes.with(|data| {
            let storage = data.storage.borrow();
            let expected = &storage[data.offset..data.offset + data.length];
            zlib_with_input(bytes, |actual| {
                assert_eq!(actual, expected);
                assert!(
                    std::ptr::eq(actual.as_ptr(), expected.as_ptr()),
                    "compression must borrow direct input instead of copying it"
                );
            });
        });
    }
}

#[test]
fn compression_preserves_views_and_observes_alias_writes() {
    let direct = bytes_from_elements(vec![99_u8, 1, 2, 3, 4, 5, 6, 88]);
    let words = bytes_from_elements(vec![0x0403_0201_u32, 0x0807_0605]);
    let views = [
        bytes_slice(&direct, 1.0, 7.0, true),
        data_view_new(&direct, 2.0, true, 4.0),
        data_view_new(&words, 1.0, true, 6.0),
        bytes_slice(&direct, 4.0, 4.0, true),
    ];
    for round in 0..2 {
        for view in &views {
            let source = bytes_u8_values(view);
            let plain = bytes_from_elements(source.clone());
            for level in [-1.0, 0.0, 1.0, 9.0] {
                let zipped = zlib_deflate_sync_level(view, level);
                assert_eq!(
                    bytes_u8_values(&zipped),
                    bytes_u8_values(&zlib_deflate_sync_level(&plain, level))
                );
                assert_eq!(bytes_u8_values(&zlib_inflate_sync(&zipped)), source);
            }
            assert_eq!(
                bytes_u8_values(&zlib_deflate_sync(view)),
                bytes_u8_values(&zlib_deflate_sync(&plain))
            );
            assert_eq!(
                bytes_u8_values(&zlib_deflate_raw_sync(view)),
                bytes_u8_values(&zlib_deflate_raw_sync(&plain))
            );
            assert_eq!(
                bytes_u8_values(&zlib_gzip_sync(view)),
                bytes_u8_values(&zlib_gzip_sync(&plain))
            );
            assert_eq!(bytes_u8_values(view), source, "compression changed input");
        }
        bytes_set(&direct, 3.0, 40.0 + f64::from(round));
        bytes_set(&words, 0.0, f64::from(0x4433_2211_u32));
    }
}

#[test]
fn input_borrow_is_released_when_the_operation_unwinds() {
    let input = bytes_from_elements(vec![1_u8, 2, 3]);
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        zlib_with_input(&input, |_| panic!("probe unwind"));
    }));
    assert!(caught.is_err());
    bytes_set(&input, 1.0, 9.0);
    assert_eq!(bytes_u8_values(&input), vec![1, 9, 3]);
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        zlib_deflate_sync_level(&input, 10.0);
    }));
    assert!(caught.is_err());
    bytes_set(&input, 0.0, 7.0);
    assert_eq!(bytes_u8_values(&input), vec![7, 9, 3]);
}
