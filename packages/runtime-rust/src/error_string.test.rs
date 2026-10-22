#[test]
fn error_string_parts_preserve_utf16_and_empty_components() {
    let high = JsString::from_utf16(&[0xd83d]);
    let low = JsString::from_utf16(&[0xde00]);
    assert_eq!(error_to_string_parts("", &high), high);
    assert_eq!(error_to_string_parts(&low, ""), low);
    assert_eq!(error_to_string_parts(&high, &low).encode_utf16().collect::<Vec<_>>(), vec![0xd83d, 58, 32, 0xde00]);
    assert_eq!(error_to_string_parts("Error", &high).encode_utf16().collect::<Vec<_>>(), vec![69, 114, 114, 111, 114, 58, 32, 0xd83d]);
}
