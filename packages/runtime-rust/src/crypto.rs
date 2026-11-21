fn crypto_random_fill(bytes: &mut [u8]) {
    getrandom::fill(bytes).expect("scriptc: operating-system random source failed");
}

fn crypto_random_size(size: f64) -> usize {
    if !(0.0..=2_147_483_647.0).contains(&size) {
        throw_value(JsError {
            identity: Rc::new(()),
            name: "RangeError".to_owned(),
            message: format!(
                "The value of \"size\" is out of range. It must be >= 0 && <= 2147483647. Received {}",
                format_number(size)
            ),
            code: Some("ERR_OUT_OF_RANGE".to_owned()),
            cause: None,
            dom: None,
        });
    }
    size as usize
}

pub fn crypto_random_bytes(size: f64) -> JsBytes<u8> {
    let mut bytes = vec![0; crypto_random_size(size)];
    crypto_random_fill(&mut bytes);
    let result = bytes_from_vec(bytes);
    // Node returns a Buffer, so encoding-aware toString applies.
    result.with_mut(|data| data.buffer = true);
    result
}

pub fn crypto_random_string(size: f64, encoding: &JsString) -> JsString {
    bytes_to_string(&crypto_random_bytes(size), encoding)
}

pub fn crypto_random_uuid() -> JsString {
    let mut bytes = [0; 16];
    crypto_random_fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(36);
    for (index, byte) in bytes.into_iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            output.push('-');
        }
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    string(&output)
}

fn crypto_der_length(length: usize) -> Vec<u8> {
    if length < 128 {
        return vec![length as u8];
    }
    let bytes = length.to_be_bytes();
    let first = bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(bytes.len() - 1);
    let significant = &bytes[first..];
    let mut encoded = Vec::with_capacity(significant.len() + 1);
    encoded.push(0x80 | significant.len() as u8);
    encoded.extend_from_slice(significant);
    encoded
}

fn crypto_der_tlv(tag: u8, contents: &[u8]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(contents.len() + 6);
    encoded.push(tag);
    encoded.extend(crypto_der_length(contents.len()));
    encoded.extend_from_slice(contents);
    encoded
}

pub fn crypto_private_key_pkcs8_pem(value: &JsString) -> JsString {
    if !value.is_well_formed() {
        throw_type_error("Private key must be a well-formed string".into());
    }
    let text = value.to_utf8_lossy();
    let begin = "-----BEGIN RSA PRIVATE KEY-----";
    let end = "-----END RSA PRIVATE KEY-----";
    let Some(start) = text.find(begin).map(|index| index + begin.len()) else {
        throw_type_error("native createPrivateKey currently requires PKCS1 PEM".into());
    };
    let Some(finish) = text[start..].find(end).map(|index| start + index) else {
        throw_type_error("Invalid PKCS1 private key PEM".into());
    };
    let body = text[start..finish]
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let pkcs1 = bytes_base64_decode(&body);
    if pkcs1.is_empty() || ring::signature::RsaKeyPair::from_der(&pkcs1).is_err() {
        throw_type_error("Invalid PKCS1 private key".into());
    }
    const RSA_ALGORITHM: &[u8] = &[
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
    ];
    let mut private_key_info = vec![0x02, 0x01, 0x00];
    private_key_info.extend_from_slice(RSA_ALGORITHM);
    private_key_info.extend(crypto_der_tlv(0x04, &pkcs1));
    let pkcs8 = crypto_der_tlv(0x30, &private_key_info);
    let encoded = bytes_base64_encode(&pkcs8);
    let mut pem = String::from("-----BEGIN PRIVATE KEY-----\n");
    for line in encoded.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
        pem.push('\n');
    }
    pem.push_str("-----END PRIVATE KEY-----\n");
    JsString::from(pem)
}

/// A digest this runtime carries, split by WHO computes it: `ring` for
/// the SHA family, this crate's own `md5.rs` for MD5, which `ring`
/// deliberately does not carry.
#[derive(Clone, Copy)]
enum CryptoDigest {
    Md5,
    Ring(&'static ring::digest::Algorithm),
}

impl CryptoDigest {
    /// The raw digest bytes. ONE place decides which implementation runs,
    /// so every entry point below — the fused static chain, the one-shot,
    /// the island bridge — agrees on the table by construction.
    fn digest(self, data: &[u8]) -> Vec<u8> {
        match self {
            Self::Md5 => md5_digest(data).to_vec(),
            Self::Ring(algorithm) => ring::digest::digest(algorithm, data).as_ref().to_vec(),
        }
    }
}

/// The five lowered digest algorithms, as a LOOKUP: `None` is "this
/// runtime has no such digest".
///
/// The static lane never reaches the `None` arm — the frontend fences
/// every other literal — but the island does: `createHash(alg)` takes a
/// runtime string, so the island needs to ask rather than assert.
fn crypto_digest_algorithm_opt(algorithm: &JsString) -> Option<CryptoDigest> {
    match algorithm.to_utf8_lossy() {
        "md5" => Some(CryptoDigest::Md5),
        "sha1" => Some(CryptoDigest::Ring(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY)),
        "sha256" => Some(CryptoDigest::Ring(&ring::digest::SHA256)),
        "sha384" => Some(CryptoDigest::Ring(&ring::digest::SHA384)),
        "sha512" => Some(CryptoDigest::Ring(&ring::digest::SHA512)),
        _ => None,
    }
}

/// The five lowered digest algorithms. The frontend fences unsupported
/// literals; a computed name is validated here with Node's error.
fn crypto_digest_algorithm(algorithm: &JsString) -> CryptoDigest {
    crypto_digest_algorithm_opt(algorithm)
        .unwrap_or_else(|| throw_error("Digest method not supported".to_owned()))
}

/// `host.digest(alg, bytes)`: the raw digest, or `None` for an algorithm
/// this runtime does not carry. The island's crypto shim probes with an
/// empty input and raises Node's "Digest method not supported" itself, so
/// an unknown name must ANSWER here, never throw.
pub fn crypto_digest_raw(algorithm: &JsString, data: &JsBytes<u8>) -> Option<JsBytes<u8>> {
    let algorithm = crypto_digest_algorithm_opt(algorithm)?;
    let digest = crypto_with_bytes(data, |data| algorithm.digest(data));
    Some(bytes_from_vec(digest))
}

/// `host.hmac(alg, key, bytes)`, with the same `None` fence as
/// `crypto_digest_raw` — the two algorithm tables carry the same names.
pub fn crypto_hmac_raw(
    algorithm: &JsString,
    key: &JsBytes<u8>,
    data: &JsBytes<u8>,
) -> Option<JsBytes<u8>> {
    let algorithm = crypto_hmac_algorithm_opt(algorithm)?;
    let tag = crypto_with_bytes(key, |key| {
        crypto_with_bytes(data, |data| algorithm.sign(key, data))
    });
    Some(bytes_from_vec(tag))
}

fn crypto_hash_digest(algorithm: &JsString, data: &[u8], encoding: &JsString) -> JsString {
    let digest = crypto_digest_algorithm(algorithm).digest(data);
    decode_bytes(&digest, encoding)
}

/// Reads a Buffer/typed-array handle's bytes. Two handles can be read at
/// once (both borrows are shared) even when they alias one storage.
fn crypto_with_bytes<T>(data: &JsBytes<u8>, body: impl FnOnce(&[u8]) -> T) -> T {
    data.with(|bytes| {
        let storage = bytes.storage.borrow();
        body(&storage[bytes.offset..bytes.offset + bytes.length])
    })
}

/// The HMAC counterpart of `CryptoDigest`. `ring::hmac` picks the block
/// size from its digest; the MD5 arm carries its own RFC 2104 wrapping
/// (block 64, like sha1/sha256) because `ring` has no MD5 to hand it to.
#[derive(Clone, Copy)]
enum CryptoHmac {
    Md5,
    Ring(ring::hmac::Algorithm),
}

impl CryptoHmac {
    fn sign(self, key: &[u8], data: &[u8]) -> Vec<u8> {
        match self {
            Self::Md5 => md5_hmac(key, data).to_vec(),
            Self::Ring(algorithm) => ring::hmac::sign(&ring::hmac::Key::new(algorithm, key), data)
                .as_ref()
                .to_vec(),
        }
    }
}

/// The HMAC counterpart of `crypto_digest_algorithm_opt` — the two tables
/// carry the same names.
fn crypto_hmac_algorithm_opt(algorithm: &JsString) -> Option<CryptoHmac> {
    match algorithm.to_utf8_lossy() {
        "md5" => Some(CryptoHmac::Md5),
        "sha1" => Some(CryptoHmac::Ring(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY)),
        "sha256" => Some(CryptoHmac::Ring(ring::hmac::HMAC_SHA256)),
        "sha384" => Some(CryptoHmac::Ring(ring::hmac::HMAC_SHA384)),
        "sha512" => Some(CryptoHmac::Ring(ring::hmac::HMAC_SHA512)),
        _ => None,
    }
}

fn crypto_hmac_algorithm(algorithm: &JsString) -> CryptoHmac {
    crypto_hmac_algorithm_opt(algorithm).unwrap_or_else(|| crypto_invalid_digest(algorithm))
}

fn crypto_hash_finalized() -> ! {
    throw_error_code(
        "Digest already called".to_owned(),
        "ERR_CRYPTO_HASH_FINALIZED",
    )
}

fn crypto_invalid_digest(algorithm: &JsString) -> ! {
    throw_type_error_code(
        format!("Invalid digest: {}", algorithm.to_utf8_lossy()),
        "ERR_CRYPTO_INVALID_DIGEST",
    )
}

pub struct CryptoHashData {
    algorithm: CryptoDigest,
    data: Vec<u8>,
    finalized: bool,
}

impl Trace for CryptoHashData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for CryptoHashData {
    fn clear_edges(&mut self) {
        self.data.fill(0);
        self.data.clear();
    }
}

impl Drop for CryptoHashData {
    fn drop(&mut self) {
        self.data.fill(0);
    }
}

pub type JsCryptoHash = Gc<CryptoHashData>;

pub struct CryptoHmacData {
    algorithm: CryptoHmac,
    key: Vec<u8>,
    data: Vec<u8>,
    finalized: bool,
}

impl Trace for CryptoHmacData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for CryptoHmacData {
    fn clear_edges(&mut self) {
        self.key.fill(0);
        self.key.clear();
        self.data.fill(0);
        self.data.clear();
    }
}

impl Drop for CryptoHmacData {
    fn drop(&mut self) {
        self.key.fill(0);
        self.data.fill(0);
    }
}

pub type JsCryptoHmac = Gc<CryptoHmacData>;

pub struct CryptoSignData {
    data: Vec<u8>,
    finalized: bool,
}

impl Trace for CryptoSignData {
    fn trace(&self, _tracer: &mut Tracer<'_>) {}
}

impl ClearEdges for CryptoSignData {
    fn clear_edges(&mut self) {
        self.data.fill(0);
        self.data.clear();
    }
}

impl Drop for CryptoSignData {
    fn drop(&mut self) {
        self.data.fill(0);
    }
}

pub type JsCryptoSign = Gc<CryptoSignData>;

fn crypto_sign_invalid_state() -> ! {
    throw_error_code("Not initialised".to_owned(), "ERR_CRYPTO_INVALID_STATE")
}

pub fn crypto_sign_new(algorithm: &JsString) -> JsCryptoSign {
    if !matches!(
        algorithm.to_utf8_lossy().to_ascii_lowercase().as_str(),
        "rsa-sha256" | "sha256"
    ) {
        crypto_invalid_digest(algorithm);
    }
    Gc::new(CryptoSignData {
        data: Vec::new(),
        finalized: false,
    })
}

pub fn crypto_sign_update_string(sign: &JsCryptoSign, value: &JsString) -> JsCryptoSign {
    sign.with_mut(|state| {
        if state.finalized {
            crypto_sign_invalid_state();
        }
        state.data.extend_from_slice(value.as_bytes());
    });
    sign.clone()
}

pub fn crypto_sign_update_bytes(sign: &JsCryptoSign, value: &JsBytes<u8>) -> JsCryptoSign {
    crypto_with_bytes(value, |bytes| {
        sign.with_mut(|state| {
            if state.finalized {
                crypto_sign_invalid_state();
            }
            state.data.extend_from_slice(bytes);
        })
    });
    sign.clone()
}

fn crypto_sign_invalid_key() -> ! {
    throw_error_code("Unsupported private key".to_owned(), "ERR_OSSL_UNSUPPORTED")
}

fn crypto_sign_bad_password() -> ! {
    throw_error_code(
        "Unable to decrypt private key".into(),
        "ERR_OSSL_BAD_DECRYPT",
    )
}

fn crypto_sign_legacy_key(text: &str, password: Option<&JsString>) -> ring::signature::RsaKeyPair {
    use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
    let password = password.unwrap_or_else(|| crypto_sign_bad_password());
    let text = text.replace('\r', "");
    let begin = "-----BEGIN RSA PRIVATE KEY-----";
    let end = "-----END RSA PRIVATE KEY-----";
    let content = text
        .split_once(begin)
        .and_then(|(_, rest)| rest.split_once(end).map(|(content, _)| content))
        .unwrap_or_else(|| crypto_sign_invalid_key());
    let (headers, body) = content
        .trim()
        .split_once("\n\n")
        .unwrap_or_else(|| crypto_sign_invalid_key());
    if !headers
        .lines()
        .any(|line| line.trim() == "Proc-Type: 4,ENCRYPTED")
    {
        crypto_sign_invalid_key();
    }
    let (cipher, iv) = headers
        .lines()
        .find_map(|line| line.trim().strip_prefix("DEK-Info: "))
        .and_then(|value| value.split_once(','))
        .unwrap_or_else(|| crypto_sign_invalid_key());
    let key_len = match cipher {
        "AES-128-CBC" => 16,
        "AES-192-CBC" => 24,
        "AES-256-CBC" => 32,
        _ => crypto_sign_invalid_key(),
    };
    let iv = bytes_hex_decode(iv);
    if iv.len() != 16 {
        crypto_sign_invalid_key();
    }
    let mut derived = Vec::with_capacity(key_len + 16);
    let mut previous = Vec::new();
    while derived.len() < key_len {
        let mut input = previous;
        input.extend_from_slice(password.as_bytes());
        input.extend_from_slice(&iv[..8]);
        previous = md5_digest(&input).to_vec();
        input.fill(0);
        derived.extend_from_slice(&previous);
    }
    previous.fill(0);
    derived.truncate(key_len);
    let mut ciphertext = bytes_base64_decode(body);
    let decrypted = match cipher {
        "AES-128-CBC" => cbc::Decryptor::<aes::Aes128>::new_from_slices(&derived, &iv)
            .expect("validated AES key")
            .decrypt_padded_mut::<Pkcs7>(&mut ciphertext),
        "AES-192-CBC" => cbc::Decryptor::<aes::Aes192>::new_from_slices(&derived, &iv)
            .expect("validated AES key")
            .decrypt_padded_mut::<Pkcs7>(&mut ciphertext),
        "AES-256-CBC" => cbc::Decryptor::<aes::Aes256>::new_from_slices(&derived, &iv)
            .expect("validated AES key")
            .decrypt_padded_mut::<Pkcs7>(&mut ciphertext),
        _ => unreachable!(),
    };
    derived.fill(0);
    let decoded = decrypted.unwrap_or_else(|_| crypto_sign_bad_password());
    let key = ring::signature::RsaKeyPair::from_der(decoded)
        .unwrap_or_else(|_| crypto_sign_bad_password());
    ciphertext.fill(0);
    key
}

fn crypto_sign_key(key: &JsString, passphrase: Option<&JsString>) -> ring::signature::RsaKeyPair {
    let text = key.to_utf8_lossy();
    if text.contains("-----BEGIN RSA PRIVATE KEY-----") && text.contains("Proc-Type: 4,ENCRYPTED") {
        return crypto_sign_legacy_key(text, passphrase);
    }
    let (label, document) =
        pkcs8::SecretDocument::from_pem(text).unwrap_or_else(|_| crypto_sign_invalid_key());
    match label {
        "RSA PRIVATE KEY" => ring::signature::RsaKeyPair::from_der(document.as_bytes())
            .unwrap_or_else(|_| crypto_sign_invalid_key()),
        "PRIVATE KEY" => ring::signature::RsaKeyPair::from_pkcs8(document.as_bytes())
            .unwrap_or_else(|_| crypto_sign_invalid_key()),
        "ENCRYPTED PRIVATE KEY" => {
            let password = passphrase.unwrap_or_else(|| {
                throw_error_code("Passphrase required".into(), "ERR_OSSL_BAD_DECRYPT")
            });
            let key = pkcs8::EncryptedPrivateKeyInfo::try_from(document.as_bytes())
                .unwrap_or_else(|_| crypto_sign_invalid_key());
            let decrypted = key.decrypt(password.as_bytes()).unwrap_or_else(|_| {
                throw_error_code(
                    "Unable to decrypt private key".into(),
                    "ERR_OSSL_BAD_DECRYPT",
                )
            });
            ring::signature::RsaKeyPair::from_pkcs8(decrypted.as_bytes())
                .unwrap_or_else(|_| crypto_sign_invalid_key())
        }
        _ => crypto_sign_invalid_key(),
    }
}

fn crypto_sign_finish(
    sign: &JsCryptoSign,
    key: &JsString,
    passphrase: Option<&JsString>,
) -> Vec<u8> {
    if sign.with(|state| state.finalized) {
        crypto_sign_invalid_state();
    }
    let key = crypto_sign_key(key, passphrase);
    let data = sign.with_mut(|state| {
        state.finalized = true;
        std::mem::take(&mut state.data)
    });
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        &data,
        &mut signature,
    )
    .unwrap_or_else(|_| throw_error("RSA signing failed".into()));
    signature
}

pub fn crypto_sign_string(
    sign: &JsCryptoSign,
    key: &JsString,
    passphrase: Option<&JsString>,
    encoding: &JsString,
) -> JsString {
    let encoding = checked_buffer_encoding(encoding);
    decode_bytes(
        &crypto_sign_finish(sign, key, passphrase),
        &string(encoding),
    )
}

pub fn crypto_sign_bytes(
    sign: &JsCryptoSign,
    key: &JsString,
    passphrase: Option<&JsString>,
) -> JsBytes<u8> {
    let result = bytes_from_vec(crypto_sign_finish(sign, key, passphrase));
    result.with_mut(|data| data.buffer = true);
    result
}

pub fn crypto_hash_new(algorithm: &JsString) -> JsCryptoHash {
    let Some(algorithm) = crypto_digest_algorithm_opt(algorithm) else {
        throw_error("Digest method not supported".to_owned());
    };
    Gc::new(CryptoHashData {
        algorithm,
        data: Vec::new(),
        finalized: false,
    })
}

fn crypto_hmac_new(algorithm: &JsString, key: Vec<u8>) -> JsCryptoHmac {
    let Some(algorithm) = crypto_hmac_algorithm_opt(algorithm) else {
        crypto_invalid_digest(algorithm);
    };
    Gc::new(CryptoHmacData {
        algorithm,
        key,
        data: Vec::new(),
        finalized: false,
    })
}

pub fn crypto_hmac_new_string(algorithm: &JsString, key: &JsString) -> JsCryptoHmac {
    crypto_hmac_new(algorithm, key.as_bytes().to_vec())
}

pub fn crypto_hmac_new_bytes(algorithm: &JsString, key: &JsBytes<u8>) -> JsCryptoHmac {
    crypto_hmac_new(algorithm, crypto_with_bytes(key, <[u8]>::to_vec))
}

pub fn crypto_hash_update_string(hash: &JsCryptoHash, data: &JsString) -> JsCryptoHash {
    hash.with_mut(|state| {
        if state.finalized {
            crypto_hash_finalized();
        }
        state.data.extend_from_slice(data.as_bytes());
    });
    hash.clone()
}

pub fn crypto_hash_update_bytes(hash: &JsCryptoHash, data: &JsBytes<u8>) -> JsCryptoHash {
    let data = crypto_with_bytes(data, <[u8]>::to_vec);
    hash.with_mut(|state| {
        if state.finalized {
            crypto_hash_finalized();
        }
        state.data.extend_from_slice(&data);
    });
    hash.clone()
}

pub fn crypto_hmac_update_string(hmac: &JsCryptoHmac, data: &JsString) -> JsCryptoHmac {
    hmac.with_mut(|state| {
        if state.finalized {
            crypto_hash_finalized();
        }
        state.data.extend_from_slice(data.as_bytes());
    });
    hmac.clone()
}

pub fn crypto_hmac_update_bytes(hmac: &JsCryptoHmac, data: &JsBytes<u8>) -> JsCryptoHmac {
    let data = crypto_with_bytes(data, <[u8]>::to_vec);
    hmac.with_mut(|state| {
        if state.finalized {
            crypto_hash_finalized();
        }
        state.data.extend_from_slice(&data);
    });
    hmac.clone()
}

pub fn crypto_hash_copy(hash: &JsCryptoHash) -> JsCryptoHash {
    hash.with(|state| {
        if state.finalized {
            crypto_hash_finalized();
        }
        Gc::new(CryptoHashData {
            algorithm: state.algorithm,
            data: state.data.clone(),
            finalized: false,
        })
    })
}

fn crypto_hash_finish(hash: &JsCryptoHash) -> Vec<u8> {
    hash.with_mut(|state| {
        if state.finalized {
            crypto_hash_finalized();
        }
        state.finalized = true;
        state.algorithm.digest(&state.data)
    })
}

fn crypto_hmac_finish(hmac: &JsCryptoHmac) -> Vec<u8> {
    hmac.with_mut(|state| {
        if state.finalized {
            return Vec::new();
        }
        state.finalized = true;
        state.algorithm.sign(&state.key, &state.data)
    })
}

pub fn crypto_hash_digest_string_handle(hash: &JsCryptoHash, encoding: &JsString) -> JsString {
    decode_bytes(&crypto_hash_finish(hash), encoding)
}

pub fn crypto_hash_digest_buffer(hash: &JsCryptoHash) -> JsBytes<u8> {
    bytes_from_vec(crypto_hash_finish(hash))
}

pub fn crypto_hmac_digest_string_handle(hmac: &JsCryptoHmac, encoding: &JsString) -> JsString {
    decode_bytes(&crypto_hmac_finish(hmac), encoding)
}

pub fn crypto_hmac_digest_buffer(hmac: &JsCryptoHmac) -> JsBytes<u8> {
    bytes_from_vec(crypto_hmac_finish(hmac))
}

/// The composed createHmac(alg, key).update(data).digest(enc) chain. The
/// key always arrives as bytes (the frontend decodes a string key's UTF-8
/// first), the data keeps the fused chain's string/bytes split.
fn crypto_hmac_digest(
    algorithm: &JsString,
    key: &JsBytes<u8>,
    data: &[u8],
    encoding: &JsString,
) -> JsString {
    let tag = crypto_with_bytes(key, |key| crypto_hmac_algorithm(algorithm).sign(key, data));
    decode_bytes(&tag, encoding)
}

pub fn crypto_hmac_digest_string(
    algorithm: &JsString,
    key: &JsBytes<u8>,
    data: &JsString,
    encoding: &JsString,
) -> JsString {
    crypto_hmac_digest(algorithm, key, data.as_bytes(), encoding)
}

/// `createHmac(algorithm, stringKey).update(text).digest(encoding)`: Node
/// encodes a string key as UTF-8 before keying the MAC.
pub fn crypto_hmac_digest_string_key(
    algorithm: &JsString,
    key: &JsString,
    data: &JsString,
    encoding: &JsString,
) -> JsString {
    let key = bytes_from_vec(key.as_bytes().to_vec());
    crypto_hmac_digest(algorithm, &key, data.as_bytes(), encoding)
}

pub fn crypto_hmac_digest_bytes(
    algorithm: &JsString,
    key: &JsBytes<u8>,
    data: &JsBytes<u8>,
    encoding: &JsString,
) -> JsString {
    crypto_with_bytes(data, |data| {
        crypto_hmac_digest(algorithm, key, data, encoding)
    })
}

/// crypto.timingSafeEqual: a constant-time comparison of two equally long
/// byte views. Node throws a RangeError with
/// ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH when the lengths differ — the
/// length itself is not secret, so the check is not constant time there.
///
/// The compare is the classic difference-accumulating fold — the same one
/// the C runtime uses, so both lanes have identical timing behaviour. It
/// deliberately does not short-circuit: every byte is read and folded
/// whatever the earlier bytes were. (ring's `constant_time` equivalent is
/// deprecated as of 0.17.14 and would fail the `-D warnings` gate.)
pub fn crypto_timing_safe_equal(first: &JsBytes<u8>, second: &JsBytes<u8>) -> bool {
    crypto_with_bytes(first, |first| {
        crypto_with_bytes(second, |second| {
            if first.len() != second.len() {
                throw_range_error_code(
                    "Input buffers must have the same byte length".to_owned(),
                    "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
                );
            }
            first
                .iter()
                .zip(second.iter())
                .fold(0u8, |difference, (left, right)| difference | (left ^ right))
                == 0
        })
    })
}

pub fn crypto_hash_digest_string(
    algorithm: &JsString,
    data: &JsString,
    encoding: &JsString,
) -> JsString {
    crypto_hash_digest(algorithm, data.as_bytes(), encoding)
}

pub fn crypto_hash_digest_bytes(
    algorithm: &JsString,
    data: &JsBytes<u8>,
    encoding: &JsString,
) -> JsString {
    crypto_with_bytes(data, |data| crypto_hash_digest(algorithm, data, encoding))
}

pub fn crypto_hash_digest_strings(
    algorithm: &JsString,
    data: &JsArray<JsString>,
    encoding: &JsString,
) -> JsString {
    let hash = crypto_hash_new(algorithm);
    data.with(|chunks| {
        for chunk in chunks.elements().iter() {
            crypto_hash_update_string(&hash, chunk);
        }
    });
    crypto_hash_digest_string_handle(&hash, encoding)
}

pub fn crypto_rsa_pkcs1_sha256(
    algorithm: &JsString,
    key: &JsBytes<u8>,
    data: &JsBytes<u8>,
) -> JsBytes<u8> {
    if algorithm.to_utf8_lossy() != "RSASSA-PKCS1-v1_5" {
        throw_error("scriptc: unsupported Web Crypto signing algorithm".to_owned());
    }
    let key = crypto_with_bytes(key, <[u8]>::to_vec);
    let data = crypto_with_bytes(data, <[u8]>::to_vec);
    let key = ring::signature::RsaKeyPair::from_pkcs8(&key)
        .unwrap_or_else(|_| throw_error("Invalid keyData".to_owned()));
    let random = ring::rand::SystemRandom::new();
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &random,
        &data,
        &mut signature,
    )
    .unwrap_or_else(|_| throw_error("Web Crypto RSA signing failed".to_owned()));
    bytes_from_vec(signature)
}

fn crypto_random_fill_range(bytes: &JsBytes<u8>, offset: f64, size: f64) -> JsBytes<u8> {
    let length = bytes.with(|data| data.length);
    let length_number = length as f64;
    if !offset.is_finite() || offset.fract() != 0.0 || !(0.0..=length_number).contains(&offset) {
        throw_range_error_code(
            format!(
                "The value of \"offset\" is out of range. It must be >= 0 && <= {}. Received {}",
                format_number(length_number),
                format_number(offset)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    if !size.is_finite() || size.fract() != 0.0 || !(0.0..=2_147_483_647.0).contains(&size) {
        throw_range_error_code(
            format!(
                "The value of \"size\" is out of range. It must be >= 0 && <= 2147483647. Received {}",
                format_number(size)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    if offset + size > length_number {
        throw_range_error_code(
            format!(
                "The value of \"size + offset\" is out of range. It must be <= {}. Received {}",
                format_number(length_number),
                format_number(offset + size)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    let offset = offset as usize;
    let size = size as usize;
    bytes.with(|data| {
        let mut storage = data.storage.borrow_mut();
        let start = data.offset + offset;
        crypto_random_fill(&mut storage[start..start + size]);
    });
    bytes.clone()
}

pub fn crypto_random_fill_bytes(bytes: &JsBytes<u8>, offset: f64, size: f64) -> JsBytes<u8> {
    crypto_random_fill_range(bytes, offset, size)
}

pub fn crypto_random_fill_rest(bytes: &JsBytes<u8>, offset: f64) -> JsBytes<u8> {
    let length = bytes.with(|data| data.length) as f64;
    crypto_random_fill_range(bytes, offset, length - offset)
}

fn crypto_require_safe_integer(value: f64, name: &str) {
    if !value.is_finite() || value.fract() != 0.0 || value.abs() > 9_007_199_254_740_991.0 {
        throw_type_error_code(
            format!("The \"{name}\" argument must be a safe integer."),
            "ERR_INVALID_ARG_TYPE",
        );
    }
}

pub fn crypto_random_int(min: f64, max: f64) -> f64 {
    crypto_require_safe_integer(min, "min");
    crypto_require_safe_integer(max, "max");
    if max <= min {
        throw_range_error_code(
            format!(
                "The value of \"max\" is out of range. It must be greater than the value of \"min\" ({}). Received {}",
                format_number(min),
                format_number(max)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    let range = max - min;
    const CEILING: u64 = 1_u64 << 48;
    if range > CEILING as f64 {
        throw_range_error_code(
            "The value of \"max - min\" is out of range. It must be <= 281474976710656.".to_owned(),
            "ERR_OUT_OF_RANGE",
        );
    }
    let span = range as u64;
    let limit = CEILING - CEILING % span;
    loop {
        let mut random = [0_u8; 6];
        crypto_random_fill(&mut random);
        let value = random.into_iter().fold(0_u64, |accumulator, byte| {
            accumulator << 8 | u64::from(byte)
        });
        if value < limit {
            return min + (value % span) as f64;
        }
    }
}

fn crypto_pbkdf2_range(value: f64, name: &str, minimum: f64) -> usize {
    if !value.is_finite() || value.fract() != 0.0 || value < minimum || value > 2_147_483_647.0 {
        throw_range_error_code(
            format!(
                "The value of \"{name}\" is out of range. It must be >= {} && <= 2147483647. Received {}",
                format_number(minimum),
                format_number(value)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    value as usize
}

pub fn crypto_pbkdf2(
    password: &JsBytes<u8>,
    salt: &JsBytes<u8>,
    iterations: f64,
    key_length: f64,
    digest: &JsString,
) -> JsBytes<u8> {
    let iterations = crypto_pbkdf2_range(iterations, "iterations", 1.0);
    let key_length = crypto_pbkdf2_range(key_length, "keylen", 0.0);
    let Some(algorithm) = crypto_hmac_algorithm_opt(digest) else {
        crypto_invalid_digest(digest);
    };
    let password = crypto_with_bytes(password, |bytes| bytes.to_vec());
    let salt = crypto_with_bytes(salt, |bytes| bytes.to_vec());
    let digest_length = algorithm.sign(&password, &[]).len();
    let mut result = Vec::with_capacity(key_length);
    let block_count = key_length.div_ceil(digest_length);
    for block_index in 1..=block_count {
        let mut block = Vec::with_capacity(salt.len() + 4);
        block.extend_from_slice(&salt);
        block.extend_from_slice(&(block_index as u32).to_be_bytes());
        let mut previous = algorithm.sign(&password, &block);
        let mut accumulated = previous.clone();
        for _ in 1..iterations {
            previous = algorithm.sign(&password, &previous);
            for (target, value) in accumulated.iter_mut().zip(&previous) {
                *target ^= value;
            }
        }
        let remaining = key_length - result.len();
        result.extend_from_slice(&accumulated[..remaining.min(digest_length)]);
        previous.fill(0);
        accumulated.fill(0);
        block.fill(0);
    }
    bytes_from_vec(result)
}

fn crypto_x509_der(input: &[u8]) -> Vec<u8> {
    if input.first() == Some(&0x30) {
        return input.to_vec();
    }
    let mut cursor = std::io::Cursor::new(input);
    if let Some(Ok(certificate)) = rustls_pemfile::certs(&mut cursor).next() {
        return certificate.as_ref().to_vec();
    }
    throw_error_code(
        "error:0480006C:PEM routines::no start line".to_owned(),
        "ERR_OSSL_PEM_NO_START_LINE",
    )
}

fn crypto_x509_fingerprint(input: &[u8]) -> JsString {
    let der = crypto_x509_der(input);
    let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, &der);
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(digest.as_ref().len() * 3 - 1);
    for (index, byte) in digest.as_ref().iter().copied().enumerate() {
        if index > 0 {
            output.push(':');
        }
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    string(&output)
}

fn crypto_der_item(input: &[u8], offset: usize) -> Option<(u8, &[u8], usize)> {
    let tag = *input.get(offset)?;
    let first_length = *input.get(offset + 1)?;
    let mut content = offset + 2;
    let length = if first_length < 0x80 {
        usize::from(first_length)
    } else {
        let count = usize::from(first_length & 0x7f);
        if count == 0 || count > std::mem::size_of::<usize>() {
            return None;
        }
        let mut length = 0usize;
        for byte in input.get(content..content.checked_add(count)?)? {
            length = length.checked_shl(8)?.checked_add(usize::from(*byte))?;
        }
        content += count;
        length
    };
    let end = content.checked_add(length)?;
    Some((tag, input.get(content..end)?, end))
}

fn crypto_x509_time(tag: u8, input: &[u8]) -> Option<JsString> {
    let expected = if tag == 0x17 {
        13
    } else if tag == 0x18 {
        15
    } else {
        return None;
    };
    if input.len() != expected
        || input.last() != Some(&b'Z')
        || !input[..input.len() - 1].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let pair =
        |offset: usize| i32::from(input[offset] - b'0') * 10 + i32::from(input[offset + 1] - b'0');
    let (year, offset) = if tag == 0x17 {
        let year = pair(0);
        (if year < 50 { year + 2000 } else { year + 1900 }, 2)
    } else {
        (pair(0) * 100 + pair(2), 4)
    };
    let month = pair(offset);
    let day = pair(offset + 2);
    let hour = pair(offset + 4);
    let minute = pair(offset + 6);
    let second = pair(offset + 8);
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month_name = MONTHS.get(usize::try_from(month - 1).ok()?)?;
    Some(string(&format!(
        "{month_name} {day:2} {hour:02}:{minute:02}:{second:02} {year} GMT"
    )))
}

fn crypto_x509_validity(input: &[u8], want_to: bool) -> JsString {
    let der = crypto_x509_der(input);
    let Some((0x30, certificate, _)) = crypto_der_item(&der, 0) else {
        return string("Bad time value");
    };
    let Some((0x30, tbs, _)) = crypto_der_item(certificate, 0) else {
        return string("Bad time value");
    };
    let mut offset = 0;
    if crypto_der_item(tbs, offset).is_some_and(|item| item.0 == 0xa0) {
        offset = crypto_der_item(tbs, offset).map_or(offset, |item| item.2);
    }
    for _ in 0..3 {
        let Some(item) = crypto_der_item(tbs, offset) else {
            return string("Bad time value");
        };
        offset = item.2;
    }
    let Some((0x30, validity, _)) = crypto_der_item(tbs, offset) else {
        return string("Bad time value");
    };
    let Some(first) = crypto_der_item(validity, 0) else {
        return string("Bad time value");
    };
    let selected = if want_to {
        let Some(second) = crypto_der_item(validity, first.2) else {
            return string("Bad time value");
        };
        second
    } else {
        first
    };
    crypto_x509_time(selected.0, selected.1).unwrap_or_else(|| string("Bad time value"))
}

macro_rules! crypto_x509_exports {
    ($bytes:ident, $text:ident, $operation:ident $(, $argument:expr)?) => {
        pub fn $bytes(data: &JsBytes<u8>) -> JsString {
            data.with(|bytes| {
                let storage = bytes.storage.borrow();
                $operation(&storage[bytes.offset..bytes.offset + bytes.length] $(, $argument)?)
            })
        }

        pub fn $text(data: &JsString) -> JsString {
            $operation(data.as_bytes() $(, $argument)?)
        }
    };
}

crypto_x509_exports!(
    crypto_x509_fingerprint_bytes,
    crypto_x509_fingerprint_string,
    crypto_x509_fingerprint
);
crypto_x509_exports!(
    crypto_x509_valid_from_bytes,
    crypto_x509_valid_from_string,
    crypto_x509_validity,
    false
);
crypto_x509_exports!(
    crypto_x509_valid_to_bytes,
    crypto_x509_valid_to_string,
    crypto_x509_validity,
    true
);
