#[derive(Clone)]
struct RegexCapture(Option<JsString>);
impl ArrayElement for RegexCapture {}

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
