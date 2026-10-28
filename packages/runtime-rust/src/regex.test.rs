#[derive(Clone)]
struct RegexCapture(Option<JsString>);
impl ArrayElement for RegexCapture {}

#[test]
fn regex_callback_receives_absent_captures_and_utf16_positions() {
    let regex = regex_new("(?<first>a)|(?<second>b)", "g");
    let mut offsets = Vec::new();
    let result = regex_replace_captures(&string("😀a b"), &regex, false, |matched| {
        offsets.push(matched.offset);
        assert_eq!(matched.input, string("😀a b"));
        assert_eq!(matched.captures.len(), 2);
        let groups = matched.groups.unwrap();
        assert_eq!(groups.len(), 2);
        if matched.matched == string("a") {
            assert_eq!(matched.captures, vec![Some(string("a")), None]);
        } else {
            assert_eq!(matched.captures, vec![None, Some(string("b"))]);
        }
        string("X")
    });
    assert_eq!(result, string("😀X X"));
    assert_eq!(offsets, [2, 4]);
}

#[test]
fn regex_callback_collects_matches_before_user_code_and_keeps_its_last_index() {
    let regex = regex_new("a", "g");
    let mut count = 0;
    let result = regex_replace_captures(&string("aaa"), &regex, false, |matched| {
        assert_eq!(regex_last_index(&regex), if count == 0 { 0.0 } else { 40.0 + (count - 1) as f64 });
        count += 1;
        regex_set_last_index(&regex, 40.0 + matched.offset as f64);
        string("X")
    });
    assert_eq!(result, string("XXX"));
    assert_eq!(count, 3);
    assert_eq!(regex_last_index(&regex), 42.0);
    let thrown = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        regex_replace_captures(&string("aa"), &regex, false, |_| {
            assert_eq!(regex_last_index(&regex), 0.0);
            regex_set_last_index(&regex, 99.0);
            throw_type_error("stop".into())
        })
    }));
    assert!(thrown.is_err());
    assert_eq!(regex_last_index(&regex), 99.0);
}

#[test]
fn regex_callback_empty_matches_advance_and_sticky_out_of_bounds_resets() {
    for (flags, expected) in [("g", vec![0, 1, 2, 3]), ("gu", vec![0, 2, 3])] {
        let mut offsets = Vec::new();
        regex_replace_captures(&string("😀x"), &regex_new("(?:)", flags), false, |matched| {
            offsets.push(matched.offset); string("|")
        });
        assert_eq!(offsets, expected);
    }
    let sticky = regex_new("a", "y");
    regex_set_last_index(&sticky, 99.0);
    assert_eq!(regex_replace_captures(&string("a"), &sticky, false, |_| panic!("no match")), string("a"));
    assert_eq!(regex_last_index(&sticky), 0.0);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        regex_replace_captures(&string("a"), &sticky, true, |_| panic!("non-global guard"))
    }));
    assert!(result.is_err());
}

#[test]
fn regex_source_serializes_literal_syntax_without_changing_matching() {
    for (pattern, expected) in [
        ("/", r"\/"),
        ("[/]", "[/]"),
        (r"\/", r"\/"),
        (r"\\/", r"\\\/"),
        ("\n", r"\n"),
        ("\r", r"\r"),
        ("\u{2028}", r"\u2028"),
        ("\u{2029}", r"\u2029"),
        ("\\\n", r"\n"),
        ("", "(?:)"),
    ] {
        assert_eq!(regex_source(&regex_new(pattern, "")).to_utf8_lossy(), expected);
    }
    assert!(regex_test(&regex_new("\n", ""), &string("a\nb")));
    let surrogate = JsString::from_utf16(&[0xd800]);
    assert_eq!(regex_source(&regex_new(&surrogate, "")).encode_utf16().collect::<Vec<_>>(), vec![0xd800]);
}

#[test]
fn regex_test_preserves_ecmascript_flags_and_state() {
    let unicode = regex_new("^.$", "u");
    let legacy = regex_new("^.$", "");
    assert!(regex_test(&unicode, &string("😀")));
    assert!(!regex_test(&legacy, &string("😀")));

    let global = regex_new(r"\d", "g");
    let text = string("1a2");
    assert!(regex_test(&global, &text));
    assert!(regex_test(&global, &text));
    assert!(!regex_test(&global, &text));
    assert!(regex_test(&global, &text));

    let sticky = regex_new("a", "y");
    assert!(regex_test(&sticky, &string("ab")));
    assert!(!regex_test(&sticky, &string("ab")));
    assert_eq!(regex_source(&global).as_ref(), r"\d");
    assert_eq!(regex_flags(&global).as_ref(), "g");
}

#[test]
fn regex_constructor_validates_and_canonicalizes_flags() {
    assert_eq!(regex_flags(&regex_new("a", "mig")).as_ref(), "gim");
    assert_eq!(regex_flags(&regex_new("a", "d")).as_ref(), "d");
    assert_eq!(regex_flags(&regex_new("a", "v")).as_ref(), "v");
    assert_eq!(regex_source(&regex_new("", "")).as_ref(), "(?:)");

    for flags in ["x", "gg", "uv"] {
        let payload =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| regex_new("a", flags)))
                .err()
                .expect("invalid RegExp flags must throw");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "SyntaxError");
        assert_eq!(
            caught_error_message(&caught).as_ref(),
            format!("Invalid flags supplied to RegExp constructor '{flags}'")
        );
    }

    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| regex_new("(", "")))
        .err()
        .expect("an invalid RegExp pattern must throw");
    let caught = caught_from_panic(payload);
    assert_eq!(caught_error_name(&caught).as_ref(), "SyntaxError");
}

#[test]
fn regex_replacement_and_split_use_utf16_ranges() {
    let astral_subject = string("😀z");
    let suffix = regex_new("z", "");
    let prefix_replacement = string("($`)");
    assert_eq!(
        regex_replace(&astral_subject, &suffix, &prefix_replacement).as_ref(),
        "😀(😀)"
    );
    assert_eq!(
        regex_replace(
            &string("14px 9em"),
            &regex_new(r"(?<n>\d+)px|(?<n>\d+)em", "g"),
            &string("[$<n>]"),
        )
        .as_ref(),
        "[14] [9]"
    );
    let pieces = regex_split(&string("a1b2c"), &regex_new(r"\d", ""), u32::MAX as f64);
    assert_eq!(array_len(&pieces), 3.0);
    assert_eq!(array_get(&pieces, 0.0).as_ref(), "a");
    assert_eq!(array_get(&pieces, 1.0).as_ref(), "b");
    assert_eq!(array_get(&pieces, 2.0).as_ref(), "c");
    assert_eq!(regexp_escape(&string("a.b")).as_ref(), r"\x61\.b");
    assert_eq!(regexp_escape(&string("- \n")).as_ref(), r"\x2d\x20\n");
}

#[test]
fn regex_split_captures_limits_and_preserves_last_index() {
    let regex = regex_new(r"(\d)", "gy");
    regex_set_last_index(&regex, 7.0);
    let values = regex_split(&string("a1b2c"), &regex, u32::MAX as f64);
    let expected = ["a", "1", "b", "2", "c"];
    assert_eq!(array_len(&values), expected.len() as f64);
    for (index, value) in expected.iter().enumerate() {
        assert_eq!(array_get(&values, index as f64).as_ref(), *value);
    }
    assert_eq!(regex_last_index(&regex), 7.0);
    let limited = regex_split(&string("a1b"), &regex, 2.0);
    assert_eq!(array_len(&limited), 2.0);
    assert_eq!(array_get(&limited, 1.0).as_ref(), "1");
    let empty = regex_split(&string(""), &regex_new("()", ""), 10.0);
    assert_eq!(array_len(&empty), 0.0);
    let missing = regex_new("(a)?b", "");
    let before_capture = regex_split(&string("xb"), &missing, 1.0);
    assert_eq!(array_get(&before_capture, 0.0).as_ref(), "x");
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        regex_split(&string("xb"), &missing, 2.0)
    }));
    assert!(error.is_err());
}

#[test]
fn regex_match_search_and_match_all_preserve_utf16_semantics() {
    let subject = string("😀a12 b");
    let matched = regex_match(&subject, &regex_new(r"(a)(\d+)", ""), |value| {
        value.unwrap()
    })
    .unwrap();
    assert_eq!(array_len(&matched), 3.0);
    assert_eq!(array_get(&matched, 0.0).as_ref(), "a12");
    assert_eq!(array_get(&matched, 1.0).as_ref(), "a");
    assert_eq!(array_get(&matched, 2.0).as_ref(), "12");
    assert_eq!(regex_search(&subject, &regex_new(r"\d+", "")), 3.0);

    let indices = array_new(Vec::new());
    let rows = regex_match_all_into(&subject, &regex_new(r"\w", "g"), &indices, |value| {
        value.unwrap()
    });
    assert_eq!(array_len(&rows), 4.0);
    assert_eq!(array_len(&indices), 4.0);
    assert_eq!(array_get(&indices, 0.0), 2.0);
    assert_eq!(array_get(&indices, 3.0), 6.0);

    let stateful = regex_new(r"\w", "g");
    assert!(regex_test(&stateful, &string("ab")));
    assert_eq!(stateful.last_index.get(), 1.0);
    let remaining = regex_match_all(&string("ab"), &stateful, |value| value.unwrap());
    assert_eq!(array_len(&remaining), 1.0);
    assert_eq!(array_get(&array_get(&remaining, 0.0), 0.0).as_ref(), "b");
    assert_eq!(stateful.last_index.get(), 1.0);
    let all = regex_match(&string("ab"), &stateful, |value| value.unwrap()).unwrap();
    assert_eq!(array_len(&all), 2.0);
    assert_eq!(stateful.last_index.get(), 0.0);
}

#[test]
fn regex_captures_distinguish_absence_from_empty_participation() {
    let capture = |value: Option<JsString>| RegexCapture(value);
    let pattern = regex_new(r"^-([^-=])(?:=([\s\S]*))?$", "");
    let absent = regex_match(&string("-f"), &pattern, capture).unwrap();
    let empty = regex_match(&string("-f="), &pattern, capture).unwrap();
    assert!(matches!(array_get(&absent, 2.0), RegexCapture(None)));
    assert!(matches!(array_get(&empty, 2.0), RegexCapture(Some(text)) if text.is_empty()));
    let rows = regex_match_all(&string("a ab"), &regex_new("a(b)?", "g"), capture);
    assert!(matches!(
        array_get(&array_get(&rows, 0.0), 1.0),
        RegexCapture(None)
    ));
    assert!(
        matches!(array_get(&array_get(&rows, 1.0), 1.0), RegexCapture(Some(text)) if text.as_ref() == "b")
    );
}

#[test]
fn regex_exec_preserves_captures_metadata_and_assigned_last_index() {
    let re = regex_new("(a)(b)?", "g");
    let subject = string("a ab");
    let first = regex_exec(&re, &subject, RegexCapture).unwrap();
    assert_eq!(array_len(&first), 3.0);
    assert!(array_get(&first, 2.0).0.is_none());
    assert_eq!(array_regex_metadata(&first).unwrap().0, 0.0);
    let second = regex_exec(&re, &subject, RegexCapture).unwrap();
    assert_eq!(array_get(&second, 2.0).0.unwrap().as_ref(), "b");
    assert_eq!(array_regex_metadata(&second).unwrap().0, 2.0);
    assert_eq!(regex_last_index(&re), 4.0);
    assert!(regex_exec(&re, &subject, RegexCapture).is_none());
    assert_eq!(regex_last_index(&re), 0.0);
    regex_set_last_index(&re, -1.5);
    assert_eq!(regex_last_index(&re), -1.5);
    assert!(regex_test(&re, &subject));
    regex_set_last_index(&re, f64::INFINITY);
    assert!(regex_exec(&re, &subject, RegexCapture).is_none());
    assert_eq!(regex_last_index(&re), 0.0);
    let unicode = regex_new(".", "gu");
    regex_set_last_index(&unicode, 1.0);
    let row = regex_exec(&unicode, &string("😀z"), RegexCapture).unwrap();
    assert_eq!(array_get(&row, 0.0).0.unwrap().as_ref(), "😀");
    assert_eq!(array_regex_metadata(&row).unwrap().0, 0.0);
    assert_eq!(regex_last_index(&unicode), 2.0);
}
