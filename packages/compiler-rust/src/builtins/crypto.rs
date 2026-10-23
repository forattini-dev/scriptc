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
        Api::runtime_only(
            "crypto",
            "randomBytes",
            Access::Call,
            &["crypto_random_bytes"],
            "Rust random bytes exist; Buffer value ABI, callback overload and size validation need native frontend tests",
        ),
        Api::runtime_only(
            "crypto",
            "createHash",
            Access::Call,
            &[
                "crypto_hash_new",
                "crypto_hash_update_string",
                "crypto_hash_update_bytes",
                "crypto_hash_digest_string_handle",
                "crypto_hash_digest_buffer",
            ],
            "Rust hash handles exist; native owning Hash class and chain/encoding contracts need porting",
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
