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
            .as_chunks::<2>()
            .0
            .iter()
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

#[test]
fn level_nine_matches_node_png_scanlines() {
    let input = bytes_from_elements(vec![
        4_u8, 255, 0, 0, 255, 1, 255, 0, 0, 4, 1, 0, 255, 0, 255, 0, 0, 0,
    ]);
    let expected = vec![
        120_u8, 218, 5, 193, 1, 13, 0, 0, 12, 195, 32, 150, 220, 191, 229, 30, 46, 90, 220, 36, 60,
        53, 94, 5, 6,
    ];
    assert_eq!(
        bytes_u8_values(&zlib_deflate_sync_level(&input, 9.0)),
        expected
    );
}

#[test]
fn level_nine_matches_node_sampled_inputs() {
    let cases = [
        (0_u8, 0_usize, "78da030000000001"),
        (0_u8, 7_usize, "78da636000030000070001"),
        (0_u8, 18_usize, "78da636040070000120001"),
        (0_u8, 129_usize, "78da63601860000000810001"),
        (0_u8, 1024_usize, "78da63601805a360148c54000004000001"),
        (
            0_u8,
            4097_usize,
            "78daedc1010d000000c2a0f74f6d0f0714000000706f10010001",
        ),
        (1_u8, 0_usize, "78da030000000001"),
        (1_u8, 7_usize, "78da636064626661650300003f0016"),
        (1_u8, 18_usize, "78da636064626661656340500001c70031"),
        (1_u8, 129_usize, "78da636064626661656318300a0060be017e"),
        (
            1_u8,
            1024_usize,
            "78da636064626661656318a546a9516ae45100fb590bfc",
        ),
        (
            1_u8,
            4097_usize,
            "78daedc5c1110030040030b4ec3fb23d5cf24964bddf139224499224e9700b2e802fff",
        ),
        (2_u8, 0_usize, "78da030000000001"),
        (2_u8, 7_usize, "78da63f09c745b25771b0009ff02fe"),
        (
            2_u8,
            18_usize,
            "78da63f09c745b2577dbffc845af4d6a8ff1476cfa0d00523d096e",
        ),
        (
            2_u8,
            129_usize,
            "78da0181007eff004992db246db6ff59a2eb347dc60f58b2fb448dd61f68b10b549de62f78c10a64adf63f88d11a63bd064f98e12a73bc165fa8f13a83cc156fb8014a93dc256ec8115aa3ec357ec7216ab3fc458ed7207ac30c559ee73079d31c65aef74089d22c75be075099e22b85ce1760a9f23b84de2770b9024b94dd3780c9125ba4ed369000a13f11",
        ),
        (
            2_u8,
            1024_usize,
            "78da2dd3075708601480e16868d0d0a0a1814a030d151a1a34346868d0d0a0a141430395061a1a34346868d0d0a0a1414383868651a950d2a0a241a272cebddf4f78ce795f0aad5b1f76ba94af99657edb77a599c9b4f4efe19beff81c4a188cee7eddeb534f6f57f8ebd08d6e2edb5a9a63773e8b7ad470583df87930b89dddad72ddd1db8382aead2c27ef7f97f16f11707afcef48d47b7ebfc68d27ee8d4bf8f6f29c79f45b39ac47dcebd986e3492362a19d5b4e3f9c930f19163eff74bd76dc905ce0cbcda7b2a66563fab79f7bb2a21e3d2975e9c526e3b409d58837dbce162da9a47cd97df139ad7ef282e2b5d75badf3e675133eeeba5045a99333bbffea2b56f3ec35cdd8811dce65aba61953d2979b184d4a96d522dff2da17d31ba68eedf1aea3b32d5854badec5695343ad97f849c4bd9add32f7c781a03636d70a0a10b730a398df11c5be0d28eee146b198278a433a503c248462d9001447f7a1784212c52ae1284e1e45f1bc028a75e2519c3d83e2550d149ba4a3b8f80f8ae90c506c938fe26a2a14b359a0d8a51cc5cd4c28e67340b14f3d8abbb9502cea81e2e076140f0aa258c61fc551ef513c2e8162e53014278da0784e1ec5da7128ce9a46f18a3a8a8dd3505cb484625a7d145be7a1b88a12c5ace628762e437113238a79ed51ec5d87e22e4e148bb8a338a80dc510a566ec00449931250d512eab45429486a9631065c1a2124449ad9708515ae6fe80282b28b4204a66b34c88d2b1f42f44d9c060045172db1542949eb53410650787154429e456095106b4b240947d024e10a5a45f234419decb03518e8a7b41940aa19d1065fcb0304439231708516ac4f44394e9935210e51fd50888d220e50b4499bfa0085152e92640941639b364434db26106d970996c6848362c201b52930d2dc98615644366b2a123d9b0816cc84d36f4241b76900d85fe037cd3fe10",
        ),
        (
            2_u8,
            4097_usize,
            "78daedd50d570f761c86f1a80c5119a23284328462846284621495212a435486a80ca10c218c428ca2328aca1095212a435486508c508ca21845651ecef97daf77b1ff4bb8ceb93fe7d61abdf5ef2ef3d23fb9ef7bfecd8a8b069353df8ff8e57607df637a13f6fcd37b497653efc36fbf5d7fdd646666a371bf3eea1e78c668dac17f07adce6fed7fb2c177dbee99cfcf6d31e5b717fd422e99cd39fedfc8cd451d83cf37fb7eef53aba585ed66fdfe6e68f80dcb4567bf18bfabb447d8d5363f1c7a6dbba6a4eb823f1a8ed97edf66e5e52fa7eeafec1f71a7d38f273e386c29efb3eccfe613639fd96fbcf9d5ec23b5c3a21ff7fce95c6397ddd583d7fed5767ad21ba71d0fbe5e784a7b6cc2cb013f5f69e971e0d3a8c8bb9de7a67d9c1c5fd177f905fd49c7ea876fbad5dee76853b79827bd1667359999523364dd35e31967749d773eec1670bab557e2ab81abf25acdcfd052c5970ca5b8a39f142fcd91e21ba652dc23488ad71448f17d0b29ee1f2ac55b8aa5f899b5140fdb20c5bbcba4f88d9d148f8d92e2035552fcd1518a27c549f1d13a296ee22ac53392a5f8b48e14b7f294e279e9527cd1408a3bf84af1926c29be6e22c5dd03a57875be14df3397e27e2152bcb9488a9f5a49f1d07029de552ac5af6da578cc7629de5f29c51f1ca47862ac141fa995e2c62e523c3d498a4f694b714b0f299e9b26c517f4a5b8bd8f142fce92e26bc652dc2d408a57e549b11ae5a8c8bb6a94f1157dd528eb876f52a3748b79a246995233448d52d779a71aa557e22b35ca0cadd16a9486eefbd428fd52dfab51e6e84d50a334f53eac461994d9488db2c0689a1aa585ff4935cad0dc166a94c56673d428ad83cfab516e286ca7465966b9488dd22eecaa1a6554495735ca2a9b956a948e1177d428e3cafba851d6d96f54a3748d7eac46995c3d588d52c769871aa567c24b188e82613c0ceb61e806c31418eac2d00b8619303484a11f0c7360680ac3201816c0d00286a1302c86a1350c37c0b00c8676308c8261150c1d611807c33a18bac23019863a30f484613a0c0d60e80bc36c189ac0301086f930348761080c8b606805c3701896c2d01686db615809430718c6c2b016862e304c82a1360c3d609806437d18fac0300b86c6300c80611e0cbbc070050c6fc3b0370cd7c3f0110c07c1701b0c5fc070240cf7c2f01d0cc7c3f0100c1bc2702a0c4fc0b0390c67c3f01c0cdbc270210cafc0b0330c97c3f0160c7bc1701d0c1fc270200cb7c2f0390c47c0700f0cdfc2701c0c0fc2b0010ca7c0f0380c9bc170160ccfc2b00d0c17c0f0320c3bc170190c6fc2b0270cd7c2f0010c07c030128615301c0ec31818d6c0d019868930d482a13b0c5361a807436f1866c2d00886fe30cc85a1190c83615808434b1886c1b0048636308c8061390ced61180dc36a183ac130414bf3ff9affd7fcbfe6ff35ffaff97fcdfffffffeff33c131f86a",
        ),
    ];
    for (mode, length, expected) in cases {
        let source = (0..length)
            .map(|i| match mode {
                0 => 0,
                1 => (i % 7) as u8,
                _ => (i.wrapping_mul(73).wrapping_add((i >> 3).wrapping_mul(17)) & 255) as u8,
            })
            .collect();
        let expected = expected
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            bytes_u8_values(&zlib_deflate_sync_level(&bytes_from_elements(source), 9.0)),
            expected,
            "mode {mode}, length {length}"
        );
    }
}

#[test]
fn level_nine_matches_node_larger_inputs() {
    let cases = [
        (
            0_u8,
            31_usize,
            "a2f884a63c6b871dcf5c77acf1e2db37bcb44e7e55c14e2deebcd04ea079ad7d",
        ),
        (
            0_u8,
            257_usize,
            "fa98be30e6d8f655c489bbb253c2cdce944b20795375f4d1068b31d5eea61df1",
        ),
        (
            0_u8,
            4096_usize,
            "8baa4be02fe8cc65e3e45a2d205ad722cd68600051734d8c44e924a5352228e6",
        ),
        (
            0_u8,
            8192_usize,
            "39ce9a213756b87abe35ce71b0326388db87d36c409c88b5abf8f9f29c0fc4b1",
        ),
        (
            0_u8,
            32768_usize,
            "3ae25da7fa4a44443ce98ce71165d8850cb7125afe18e5f5f601fa486e1305d0",
        ),
        (
            0_u8,
            65536_usize,
            "ba6aa374efb61495804210054fcefc9f8265dbeddcbc7c0916b97a4c15a99e2d",
        ),
        (
            1_u8,
            31_usize,
            "752cce5553a4d9c1c1945ff89875da6c22735c9bcca85b8628b8f2f0babc5bd9",
        ),
        (
            1_u8,
            257_usize,
            "94c8c52957a79d99215a635dc10eabe894e102a81a8a9f8e5bc84d32eccd0c6f",
        ),
        (
            1_u8,
            4096_usize,
            "c80a42ee8e802f4108c4b949526dae08530b530dbe638f4f96ac2232c85b1443",
        ),
        (
            1_u8,
            8192_usize,
            "57deb9b1b6b5aa4280d8b4885bdc6247a57616d363475e22db4c20e55cf38db2",
        ),
        (
            1_u8,
            32768_usize,
            "f229c5ff5b88ad2e574e64cda7784c68295dd6cb012e64e4f6db3c4013facadb",
        ),
        (
            1_u8,
            65536_usize,
            "07f47b0870539db9e3342670c825d389782eaa2c4d6cef75fa2e789f922ba23e",
        ),
        (
            2_u8,
            31_usize,
            "55da2dd539c15a1268f6f7e633b571952ddc06ba58168efe1ee8d3429a1f1966",
        ),
        (
            2_u8,
            257_usize,
            "89c6633b6c4ceddcaeb991eb8dc1efb1b97105bb2b0f7380a45cc8ce118b43a7",
        ),
        (
            2_u8,
            4096_usize,
            "f21394951c8d76b14b6e388cf66c4857450f290c89afea074d7a04b7cc1d7cda",
        ),
        (
            2_u8,
            8192_usize,
            "301d9456be5ea3b603e6074b45b33c55dab1fefd7c78a3d0245fc801160e2526",
        ),
        (
            2_u8,
            32768_usize,
            "61dbce8ccb2b39fec1694898a734605f3eef631fdf5ef4182a5e68aad43a316e",
        ),
        (
            2_u8,
            65536_usize,
            "242d199f5bb9408916a4f66e4eaf1e410df46e2117bbe6fe614afa023b494496",
        ),
    ];
    for (mode, length, expected) in cases {
        let mut seed = 0x1234_5678_u32;
        let source = (0..length)
            .map(|i| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                match mode {
                    0 => (seed >> 24) as u8,
                    1 => ((seed >> 24) & 15) as u8,
                    _ => ((i / 13) % 251) as u8,
                }
            })
            .collect();
        let compressed =
            bytes_u8_values(&zlib_deflate_sync_level(&bytes_from_elements(source), 9.0));
        let actual = ring::digest::digest(&ring::digest::SHA256, &compressed)
            .as_ref()
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>();
        assert_eq!(actual, expected, "mode {mode}, length {length}");
    }
}
