fn native_crypto_sign_key(value: NativeValue) -> (runtime::JsString, Option<runtime::JsString>) {
    if let NativeValue::String(key) = value {
        return (key, None);
    }
    if !native_value_test(&value, "objectInstance") {
        runtime::throw_type_error_code(
            "The key argument must be a string or an options object".into(),
            "ERR_INVALID_ARG_TYPE",
        );
    }
    for name in ["padding", "saltLength", "dsaEncoding", "format", "type"] {
        if !matches!(
            native_value_get(value.clone(), runtime::string(name)),
            NativeValue::Undefined
        ) {
            runtime::throw_error_code(
                format!("scriptc: Sign key option {name} is not supported yet"),
                "SC1031",
            );
        }
    }
    let key = native_value_get(value.clone(), runtime::string("key"));
    let passphrase = native_value_get(value, runtime::string("passphrase"));
    let NativeValue::String(key) = key else {
        runtime::throw_type_error_code(
            "The key option must be a string".into(),
            "ERR_INVALID_ARG_TYPE",
        );
    };
    let passphrase = match passphrase {
        NativeValue::Undefined => None,
        NativeValue::String(value) => Some(value),
        _ => runtime::throw_type_error_code(
            "The passphrase option must be a string".into(),
            "ERR_INVALID_ARG_TYPE",
        ),
    };
    (key, passphrase)
}

fn native_crypto_sign_string(
    sign: &runtime::JsCryptoSign,
    value: NativeValue,
    encoding: &runtime::JsString,
) -> runtime::JsString {
    let (key, passphrase) = native_crypto_sign_key(value);
    runtime::crypto_sign_string(sign, &key, passphrase.as_ref(), encoding)
}

fn native_crypto_sign_bytes(
    sign: &runtime::JsCryptoSign,
    value: NativeValue,
) -> runtime::JsBytes<u8> {
    let (key, passphrase) = native_crypto_sign_key(value);
    runtime::crypto_sign_bytes(sign, &key, passphrase.as_ref())
}
