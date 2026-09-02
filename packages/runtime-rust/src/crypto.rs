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
    bytes_from_vec(bytes)
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
    match algorithm.as_ref() {
        "md5" => Some(CryptoDigest::Md5),
        "sha1" => Some(CryptoDigest::Ring(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY)),
        "sha256" => Some(CryptoDigest::Ring(&ring::digest::SHA256)),
        "sha384" => Some(CryptoDigest::Ring(&ring::digest::SHA384)),
        "sha512" => Some(CryptoDigest::Ring(&ring::digest::SHA512)),
        _ => None,
    }
}

/// The five lowered digest algorithms. The frontend fences every other
/// literal, so an unknown name here is a compiler invariant break.
fn crypto_digest_algorithm(algorithm: &JsString) -> CryptoDigest {
    crypto_digest_algorithm_opt(algorithm)
        .unwrap_or_else(|| unreachable!("scriptc invariant: unsupported hash algorithm reached the runtime"))
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
    decode_bytes(&digest, encoding.as_ref())
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
            Self::Ring(algorithm) => {
                ring::hmac::sign(&ring::hmac::Key::new(algorithm, key), data).as_ref().to_vec()
            }
        }
    }
}

/// The HMAC counterpart of `crypto_digest_algorithm_opt` — the two tables
/// carry the same names.
fn crypto_hmac_algorithm_opt(algorithm: &JsString) -> Option<CryptoHmac> {
    match algorithm.as_ref() {
        "md5" => Some(CryptoHmac::Md5),
        "sha1" => Some(CryptoHmac::Ring(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY)),
        "sha256" => Some(CryptoHmac::Ring(ring::hmac::HMAC_SHA256)),
        "sha384" => Some(CryptoHmac::Ring(ring::hmac::HMAC_SHA384)),
        "sha512" => Some(CryptoHmac::Ring(ring::hmac::HMAC_SHA512)),
        _ => None,
    }
}

fn crypto_hmac_algorithm(algorithm: &JsString) -> CryptoHmac {
    crypto_hmac_algorithm_opt(algorithm)
        .unwrap_or_else(|| unreachable!("scriptc invariant: unsupported HMAC algorithm reached the runtime"))
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
    decode_bytes(&tag, encoding.as_ref())
}

pub fn crypto_hmac_digest_string(
    algorithm: &JsString,
    key: &JsBytes<u8>,
    data: &JsString,
    encoding: &JsString,
) -> JsString {
    crypto_hmac_digest(algorithm, key, data.as_bytes(), encoding)
}

pub fn crypto_hmac_digest_bytes(
    algorithm: &JsString,
    key: &JsBytes<u8>,
    data: &JsBytes<u8>,
    encoding: &JsString,
) -> JsString {
    crypto_with_bytes(data, |data| crypto_hmac_digest(algorithm, key, data, encoding))
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
    let expected = if tag == 0x17 { 13 } else if tag == 0x18 { 15 } else { return None };
    if input.len() != expected || input.last() != Some(&b'Z') ||
        !input[..input.len() - 1].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let pair = |offset: usize| i32::from(input[offset] - b'0') * 10 + i32::from(input[offset + 1] - b'0');
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
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
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

crypto_x509_exports!(crypto_x509_fingerprint_bytes, crypto_x509_fingerprint_string, crypto_x509_fingerprint);
crypto_x509_exports!(crypto_x509_valid_from_bytes, crypto_x509_valid_from_string, crypto_x509_validity, false);
crypto_x509_exports!(crypto_x509_valid_to_bytes, crypto_x509_valid_to_string, crypto_x509_validity, true);
