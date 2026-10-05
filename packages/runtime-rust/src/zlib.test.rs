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
        let expected: Vec<u8> = expected
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect();
        assert_eq!(
            bytes_u8_values(&zlib_deflate_raw_sync(&input)),
            expected,
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
