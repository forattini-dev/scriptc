    #[test]
    fn text_decoder_strips_boms_and_replaces_malformed_sequences() {
        let bytes = |values: &[u8]| bytes_from_elements(values.to_vec());

        assert_eq!(text_decode(&bytes(&[0xef, 0xbb, 0xbf, 0x41])).as_ref(), "A");
        assert_eq!(text_decode(&bytes(&[0x41, 0xff, 0x42])).as_ref(), "A�B");
        assert_eq!(text_decode(&bytes(&[0xf0, 0x9f, 0x98])).as_ref(), "�");
        assert_eq!(
            text_decode_legacy(&bytes(&[0xff, 0xfe, 0x61, 0x00]), 28.0).as_ref(),
            "a",
        );
        assert_eq!(
            text_decode_legacy(&bytes(&[0xfe, 0xff, 0x00, 0x61]), 29.0).as_ref(),
            "a",
        );
    }

    #[test]
    fn text_decoder_covers_single_and_multibyte_whatwg_families() {
        let bytes = |values: &[u8]| bytes_from_elements(values.to_vec());

        assert_eq!(text_decode_legacy(&bytes(&[0x80]), 19.0).as_ref(), "€");
        assert_eq!(text_decode_legacy(&bytes(&[0x80]), 27.0).as_ref(), "");
        assert_eq!(text_decode_legacy(&bytes(&[0xd6, 0xd0, 0xce, 0xc4]), 30.0).as_ref(), "中文");
        assert_eq!(text_decode_legacy(&bytes(&[0xa4, 0xa4, 0xa4, 0xe5]), 31.0).as_ref(), "中文");
        assert_eq!(text_decode_legacy(&bytes(&[0x93, 0xfa, 0x96, 0x7b]), 34.0).as_ref(), "日本");
        assert_eq!(text_decode_legacy(&bytes(&[0xc7, 0xd1, 0xb1, 0xdb]), 35.0).as_ref(), "한글");
    }
