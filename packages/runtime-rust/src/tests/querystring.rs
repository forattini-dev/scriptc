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
}
