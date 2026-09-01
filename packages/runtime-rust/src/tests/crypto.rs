    #[test]
    fn crypto_random_values_have_node_shapes_and_errors() {
        let uuid = crypto_random_uuid();
        assert_eq!(uuid.len(), 36);
        assert_eq!(&uuid[8..9], "-");
        assert_eq!(&uuid[13..15], "-4");
        assert_eq!(&uuid[18..19], "-");
        assert_eq!(&uuid[23..24], "-");
        assert!(matches!(uuid.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        assert!(uuid
            .bytes()
            .all(|byte| byte == b'-' || byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));

        let bytes = crypto_random_bytes(8.9);
        assert_eq!(bytes_len(&bytes), 8.0);
        assert_eq!(crypto_random_string(5.0, &string("base64")).len(), 8);

        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crypto_random_bytes(-1.0)
        }))
        .err()
        .expect("a negative random byte size must throw");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
        assert_eq!(
            caught_error_code(&caught).expect("error code").as_ref(),
            "ERR_OUT_OF_RANGE"
        );
        assert_eq!(
            caught_error_message(&caught).as_ref(),
            "The value of \"size\" is out of range. It must be >= 0 && <= 2147483647. Received -1"
        );
    }

    #[test]
    fn crypto_hash_digests_match_node_encodings() {
        assert_eq!(
            crypto_hash_digest_string(&string("sha256"), &string("abc"), &string("hex")).as_ref(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        assert_eq!(
            crypto_hash_digest_bytes(&string("sha1"), &bytes_from_vec(b"abc".to_vec()), &string("base64")).as_ref(),
            "qZk+NkcGgWq6PiVxeFDCbJzQ2J0=",
        );
        // FIPS 180-4 one-block "abc" vectors for the wider digests.
        assert_eq!(
            crypto_hash_digest_string(&string("sha384"), &string("abc"), &string("hex")).as_ref(),
            "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed\
             8086072ba1e7cc2358baeca134c825a7",
        );
        assert_eq!(
            crypto_hash_digest_bytes(&string("sha512"), &bytes_from_vec(b"abc".to_vec()), &string("hex")).as_ref(),
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a\
             2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
        );
    }

    #[test]
    fn crypto_hmac_digests_match_rfc_4231_vectors() {
        // RFC 4231 test case 1: a 20-byte 0x0b key over "Hi There".
        let key = bytes_from_vec(vec![0x0b; 20]);
        let hex = string("hex");
        assert_eq!(
            crypto_hmac_digest_string(&string("sha256"), &key, &string("Hi There"), &hex).as_ref(),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
        );
        assert_eq!(
            crypto_hmac_digest_string(&string("sha384"), &key, &string("Hi There"), &hex).as_ref(),
            "afd03944d84895626b0825f4ab46907f15f9dadbe4101ec682aa034c7cebc59c\
             faea9ea9076ede7f4af152e8b2fa9cb6",
        );
        assert_eq!(
            crypto_hmac_digest_bytes(
                &string("sha512"),
                &key,
                &bytes_from_vec(b"Hi There".to_vec()),
                &hex,
            )
            .as_ref(),
            "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cde\
             daa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854",
        );
        // RFC 2202 test case 2 (the same message under HMAC-SHA-1).
        assert_eq!(
            crypto_hmac_digest_string(&string("sha1"), &key, &string("Hi There"), &hex).as_ref(),
            "b617318655057264e28bc0b6fb378c8ef146be00",
        );
        // RFC 4231 test case 2: a short ASCII key, base64 output included.
        let jefe = bytes_from_vec(b"Jefe".to_vec());
        let message = string("what do ya want for nothing?");
        assert_eq!(
            crypto_hmac_digest_string(&string("sha256"), &jefe, &message, &hex).as_ref(),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        );
        assert_eq!(
            crypto_hmac_digest_string(&string("sha512"), &jefe, &message, &hex).as_ref(),
            "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554\
             9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737",
        );
        assert_eq!(
            crypto_hmac_digest_string(
                &string("sha256"),
                &bytes_from_vec(b"key".to_vec()),
                &string("msg"),
                &string("base64"),
            )
            .as_ref(),
            "LZPLwb4We8sWN6SiPL/wGnh48MUO6DOVTqUiG7G4xig=",
        );
    }

    #[test]
    fn crypto_timing_safe_equal_compares_equal_lengths_and_throws_otherwise() {
        let first = bytes_from_vec(b"abcdef".to_vec());
        assert!(crypto_timing_safe_equal(&first, &bytes_from_vec(b"abcdef".to_vec())));
        assert!(!crypto_timing_safe_equal(&first, &bytes_from_vec(b"abcdeg".to_vec())));
        assert!(crypto_timing_safe_equal(&first, &first));
        assert!(crypto_timing_safe_equal(&bytes_from_vec(Vec::new()), &bytes_from_vec(Vec::new())));

        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crypto_timing_safe_equal(&bytes_from_vec(b"ab".to_vec()), &bytes_from_vec(b"abc".to_vec()))
        }))
        .expect_err("mismatched byte lengths must throw");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
        assert_eq!(
            caught_error_code(&caught).expect("error code").as_ref(),
            "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH"
        );
        assert_eq!(
            caught_error_message(&caught).as_ref(),
            "Input buffers must have the same byte length"
        );
    }
