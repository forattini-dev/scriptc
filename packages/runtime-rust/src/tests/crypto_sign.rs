#[test]
fn rsa_sign_matches_node_for_plain_and_encrypted_test_keys() {
    // These checked-in keys are generated solely for this test corpus.
    let plain_pkcs1 = string(include_str!(
        "../../../../tests/corpus/5511-crypto-sign/pkcs1.pem"
    ));
    let plain_pkcs8 = string(include_str!(
        "../../../../tests/corpus/5511-crypto-sign/pkcs8.pem"
    ));
    let encrypted = string(include_str!(
        "../../../../tests/corpus/5511-crypto-sign/encrypted.pem"
    ));
    let encrypted_legacy = string(include_str!(
        "../../../../tests/corpus/5511-crypto-sign/encrypted-legacy.pem"
    ));
    let expected = include_str!("../../../../tests/corpus/5511-crypto-sign/signature.txt").trim();
    let password = string("fixture-password");
    for (key, passphrase) in [
        (&plain_pkcs1, None),
        (&plain_pkcs8, None),
        (&encrypted, Some(&password)),
        (&encrypted_legacy, Some(&password)),
    ] {
        let signer = crypto_sign_new(&string("RSA-SHA256"));
        assert!(crypto_sign_update_string(&signer, &string("hello ")).ptr_eq(&signer));
        let data = buffer_from_string(&string("world"), &string("utf8"));
        crypto_sign_update_bytes(&signer, &data);
        let result = crypto_sign_string(&signer, key, passphrase, &string("base64"));
        assert_eq!(result.as_ref(), expected);
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crypto_sign_update_string(&signer, &string("again"))
        }))
        .err()
        .expect("finalized signer rejects updates");
        assert_eq!(
            caught_error_code(&caught_from_panic(panic)).as_deref(),
            Some("ERR_CRYPTO_INVALID_STATE")
        );
    }
}

#[test]
fn rsa_sign_wrong_passphrase_does_not_finalize_the_signer() {
    let encrypted = string(include_str!(
        "../../../../tests/corpus/5511-crypto-sign/encrypted.pem"
    ));
    let expected = include_str!("../../../../tests/corpus/5511-crypto-sign/signature.txt").trim();
    let signer = crypto_sign_new(&string("sha256"));
    crypto_sign_update_string(&signer, &string("hello world"));
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crypto_sign_string(
            &signer,
            &encrypted,
            Some(&string("wrong")),
            &string("base64"),
        )
    }))
    .err()
    .expect("wrong password must fail");
    assert_eq!(
        caught_error_code(&caught_from_panic(panic)).as_deref(),
        Some("ERR_OSSL_BAD_DECRYPT")
    );
    assert_eq!(
        crypto_sign_string(
            &signer,
            &encrypted,
            Some(&string("fixture-password")),
            &string("base64")
        )
        .as_ref(),
        expected
    );
}
