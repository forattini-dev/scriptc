use super::*;
use crate::{caught_error_code, caught_error_message, caught_error_name, caught_from_panic};

#[test]
fn file_paths_decode_unicode_and_keep_double_encoded_separators() {
    let prefix = if cfg!(windows) {
        "file:///C:/"
    } else {
        "file:///"
    };
    let expected = if cfg!(windows) {
        "C:\\a b\\café\\%2F"
    } else {
        "/a b/café/%2F"
    };
    assert_eq!(
        url_string_to_path(&string(&format!("{prefix}a%20b/caf%C3%A9/%252F"))).as_ref(),
        expected
    );
}

#[test]
fn file_paths_keep_node_error_codes_and_separator_precedence() {
    let prefix = if cfg!(windows) {
        "file:///C:/"
    } else {
        "file:///"
    };
    for (input, code) in [
        ("bad".into(), "ERR_INVALID_URL"),
        ("https://example.com/".into(), "ERR_INVALID_URL_SCHEME"),
        (format!("{prefix}%zz%2F"), "ERR_INVALID_FILE_URL_PATH"),
    ] {
        let caught = caught_from_panic(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                url_string_to_path(&string(&input))
            }))
            .expect_err("must throw"),
        );
        assert_eq!(caught_error_code(&caught), Some(string(code)));
        assert_eq!(caught_error_name(&caught).as_ref(), "TypeError");
    }
}

#[test]
fn file_paths_reject_malformed_percent_and_utf8_without_replacement() {
    let prefix = if cfg!(windows) {
        "file:///C:/"
    } else {
        "file:///"
    };
    for suffix in ["%", "%0", "%zz", "%FF", "%C0%AF", "%ED%A0%80", "%E2%82"] {
        let caught = caught_from_panic(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                url_string_to_path(&string(&format!("{prefix}{suffix}")))
            }))
            .expect_err("invalid URI must throw"),
        );
        assert_eq!(caught_error_name(&caught).as_ref(), "URIError", "{suffix}");
        assert_eq!(
            caught_error_message(&caught).as_ref(),
            "URI malformed",
            "{suffix}"
        );
    }
}
