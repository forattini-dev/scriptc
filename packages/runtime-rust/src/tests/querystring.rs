#[test]
fn querystring_codecs_cover_strict_and_legacy_decoding() {
    assert_eq!(
        querystring_escape(&string("héllo ☃ a+b")),
        string("h%C3%A9llo%20%E2%98%83%20a%2Bb"),
    );
    assert_eq!(querystring_unescape(&string("%E2%98%83")), string("☃"));
    assert_eq!(querystring_unescape(&string("%GG%41")), string("%GGA"));
    assert_eq!(querystring_unescape(&string("☃%E9")), string("\u{3}\u{fffd}"));
    assert_eq!(querystring_unescape(&string("😀%E9")), string("=\0\u{fffd}"));
    let lone = JsString::from_utf16(&[0xd800, b'%' as u16, b'4' as u16, b'1' as u16]);
    let expected = JsString::from_utf16(&[0xd800, b'A' as u16]);
    assert_eq!(querystring_unescape(&lone), expected);
    assert_eq!(string_decode_uri_component(&lone), expected);
    let bad = JsString::from_utf16(&[0xd800, b'%' as u16, b'F' as u16, b'F' as u16]);
    assert_eq!(querystring_unescape(&bad), string("\0\u{fffd}"));
}
