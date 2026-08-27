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

fn crypto_hash_digest(algorithm: &JsString, data: &[u8], encoding: &JsString) -> JsString {
    let algorithm = match algorithm.as_ref() {
        "sha1" => &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
        "sha256" => &ring::digest::SHA256,
        _ => unreachable!("scriptc invariant: unsupported hash algorithm reached the runtime"),
    };
    let digest = ring::digest::digest(algorithm, data);
    decode_bytes(digest.as_ref(), encoding.as_ref())
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
    data.with(|bytes| {
        let storage = bytes.storage.borrow();
        crypto_hash_digest(
            algorithm,
            &storage[bytes.offset..bytes.offset + bytes.length],
            encoding,
        )
    })
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
