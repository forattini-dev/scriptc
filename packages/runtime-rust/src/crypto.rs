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
