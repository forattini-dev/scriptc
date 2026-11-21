use super::*;
pub(super) fn apis() -> Vec<Api> {
    vec![
        Api::native(
            "crypto",
            "randomUUID",
            Lowering::Direct,
            vec![call!(
                "crypto.randomUUID",
                [],
                Type::String,
                "crypto_random_uuid"
            )],
            "Zero-argument UUID v4 generation through the Rust OS entropy source; options and function values refused",
            &["tests/corpus/rust-native-platform/crypto.ts"],
        ),
        Api::native(
            "crypto",
            "randomBytes",
            Lowering::Direct,
            vec![call!(
                "crypto.randomBytes",
                [Type::F64],
                Type::bytes(),
                "crypto_random_bytes"
            )],
            "Synchronous randomBytes(size) returning a native Buffer from the OS entropy source with Node's size RangeError; the callback overload remains refused",
            &["tests/corpus/rust-native-crypto-random-bytes/main.ts"],
        ),
        Api::native(
            "crypto",
            "createHash",
            Lowering::Special,
            vec![
                call!(
                    "crypto.hashString",
                    [Type::String, Type::String, Type::String],
                    Type::String,
                    "crypto_hash_digest_string"
                ),
                call!(
                    "crypto.hashBytes",
                    [Type::String, Type::bytes(), Type::String],
                    Type::String,
                    "crypto_hash_digest_bytes"
                ),
                call!(
                    "crypto.hashStrings",
                    [Type::String, strings(), Type::String],
                    Type::String,
                    "crypto_hash_digest_strings"
                ),
                call!(
                    "crypto.hashNew",
                    [Type::String],
                    Type::CryptoHash,
                    "crypto_hash_new"
                ),
                call!(
                    "crypto.hashUpdateString",
                    [Type::CryptoHash, Type::String],
                    Type::CryptoHash,
                    "crypto_hash_update_string"
                ),
                call!(
                    "crypto.hashUpdateBytes",
                    [Type::CryptoHash, Type::bytes()],
                    Type::CryptoHash,
                    "crypto_hash_update_bytes"
                ),
                call!(
                    "crypto.hashDigest",
                    [Type::CryptoHash, Type::String],
                    Type::String,
                    "crypto_hash_digest_string_handle"
                ),
            ],
            "Fused and materialized createHash/Bun.CryptoHasher handles preserve ordered string/byte updates and digest encoding through the native Rust digest table",
            &[
                "tests/corpus/4977-crypto-hash-json-chain.ts",
                "tests/corpus/5255-crypto-hash-multiple-updates.ts",
                "tests/corpus/rust-bun-file-text/hash.ts",
            ],
        ),
        Api::native(
            "crypto",
            "createSign",
            Lowering::Special,
            vec![
                call!(
                    "crypto.signNew",
                    [Type::String],
                    Type::CryptoSign,
                    "crypto_sign_new"
                ),
                call!(
                    "crypto.signUpdateString",
                    [Type::CryptoSign, Type::String],
                    Type::CryptoSign,
                    "crypto_sign_update_string"
                ),
                call!(
                    "crypto.signUpdateBytes",
                    [Type::CryptoSign, Type::bytes()],
                    Type::CryptoSign,
                    "crypto_sign_update_bytes"
                ),
                Builtin {
                    ir: "crypto.signFinalString",
                    args: vec![Type::CryptoSign, Type::Dyn, Type::String],
                    result: Type::String,
                    implementation: Implementation::NativeHelper("native_crypto_sign_string"),
                },
                Builtin {
                    ir: "crypto.signFinalBytes",
                    args: vec![Type::CryptoSign, Type::Dyn],
                    result: Type::bytes(),
                    implementation: Implementation::NativeHelper("native_crypto_sign_bytes"),
                },
            ],
            "Native RSA-SHA256 signer with PEM private keys; unsupported key and algorithm variants are rejected",
            &["tests/corpus/5511-crypto-sign/main.cjs"],
        ),
        Api::native(
            "crypto",
            "createPrivateKey",
            Lowering::Special,
            vec![call!(
                "crypto.privateKeyPkcs8Pem",
                [Type::String],
                Type::String,
                "crypto_private_key_pkcs8_pem"
            )],
            "Fused createPrivateKey(PKCS1 PEM).export({ type: 'pkcs8', format: 'pem' }) conversion backed by native DER/PEM handling. Materialized KeyObject identity and other input/export formats remain fenced",
            &["tests/corpus/5088-crypto-private-key-export.js"],
        ),
        Api::runtime_only(
            "crypto",
            "createHmac",
            Access::Call,
            &[
                "crypto_hmac_new_string",
                "crypto_hmac_new_bytes",
                "crypto_hmac_update_string",
                "crypto_hmac_digest_string_handle",
            ],
            "Rust HMAC handles exist; native key/bytes/encoding and owning class contracts need porting",
        ),
        Api::runtime_only(
            "crypto",
            "timingSafeEqual",
            Access::Call,
            &["crypto_timing_safe_equal"],
            "Rust bytes comparison exists; native Buffer/ArrayBuffer view contracts need porting",
        ),
    ]
}

pub(super) fn internal() -> Vec<Builtin> {
    vec![
        call!(
            "crypto.rsaPkcs1Sha256",
            [Type::String, Type::bytes(), Type::bytes()],
            Type::bytes(),
            "crypto_rsa_pkcs1_sha256"
        ),
        // Fused createHmac(algorithm, stringKey).update(text).digest(enc).
        call!(
            "crypto.hmacStringKey",
            [Type::String, Type::String, Type::String, Type::String],
            Type::String,
            "crypto_hmac_digest_string_key"
        ),
    ]
}
