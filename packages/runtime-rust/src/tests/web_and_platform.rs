    struct Link {
        next: Option<Gc<Link>>,
    }

    impl Trace for Link {
        fn trace(&self, tracer: &mut Tracer<'_>) {
            if let Some(next) = &self.next {
                tracer.edge(next);
            }
        }
    }

    impl ClearEdges for Link {
        fn clear_edges(&mut self) {
            self.next = None;
        }
    }

    #[test]
    fn formats_javascript_special_numbers() {
        assert_eq!(format_number(f64::NAN), "NaN");
        assert_eq!(format_number(f64::INFINITY), "Infinity");
        assert_eq!(format_number(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(format_number(-0.0), "0");
        assert_eq!(format_number(1e21), "1e+21");
        assert_eq!(format_number(1e-7), "1e-7");
        assert_eq!(format_number(1e-6), "0.000001");
        assert_eq!(format_number(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(display_number(-0.0), "-0");
    }

    #[test]
    fn date_time_clip_and_iso_format_match_ecmascript() {
        assert_eq!(date_new_ms(1.9), 1.0);
        assert_eq!(date_new_ms(-1.9), -1.0);
        assert!(date_new_ms(-0.0).is_sign_positive());
        assert!(date_new_ms(f64::INFINITY).is_nan());
        assert!(date_new_ms(8_640_000_000_000_001.0).is_nan());
        assert_eq!(date_get_time(42.0), 42.0);

        for (millis, expected) in [
            (0.0, "1970-01-01T00:00:00.000Z"),
            (-1.0, "1969-12-31T23:59:59.999Z"),
            (253_402_300_800_000.0, "+010000-01-01T00:00:00.000Z"),
            (-62_198_755_200_000.0, "-000001-01-01T00:00:00.000Z"),
            (8_640_000_000_000_000.0, "+275760-09-13T00:00:00.000Z"),
            (-8_640_000_000_000_000.0, "-271821-04-20T00:00:00.000Z"),
        ] {
            assert_eq!(date_to_iso(millis).as_ref(), expected);
        }

        let payload =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| date_to_iso(f64::NAN)))
                .expect_err("an invalid Date must throw");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
        assert_eq!(caught_error_message(&caught).as_ref(), "Invalid time value");
    }

    #[test]
    fn date_utc_rolls_components_and_clips_like_ecmascript() {
        assert_eq!(
            date_utc(2017.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0),
            1_483_228_800_000.0
        );
        assert_eq!(
            date_utc(2017.0, 13.0, 1.0, 0.0, 0.0, 0.0, 0.0),
            1_517_443_200_000.0
        );
        assert_eq!(
            date_utc(96.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0),
            823_230_245_006.0
        );
        assert_eq!(
            date_utc(2017.0, 0.0, 60.0, 0.0, 0.0, 0.0, 0.0),
            1_488_326_400_000.0
        );
        assert_eq!(
            date_utc(2000.0, -3.0, 1.0, 0.0, 0.0, 0.0, 0.0),
            938_736_000_000.0
        );
        assert_eq!(
            date_utc(-1.0, 0.0, 1.0, 0.0, 0.0, 0.0, -1.0),
            -62_198_755_200_001.0
        );
        assert!(date_utc(f64::NAN, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0).is_nan());
        assert!(date_utc(1_000_001.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0).is_nan());
        assert!(date_utc(2017.0, 10_000_001.0, 1.0, 0.0, 0.0, 0.0, 0.0).is_nan());
    }

    #[test]
    fn date_parser_and_calendar_getters_cover_stored_dates() {
        let instant = date_parse_get_time(&string("2024-07-04T12:34:56.789Z"));
        assert_eq!(instant, 1_720_096_496_789.0);
        assert_eq!(date_get_full_year(instant, true), 2024.0);
        assert_eq!(date_get_month(instant, true), 6.0);
        assert_eq!(date_get_date(instant, true), 4.0);
        assert_eq!(date_get_day(instant, true), 4.0);
        assert_eq!(date_get_hours(instant, true), 12.0);
        assert_eq!(date_get_minutes(instant, true), 34.0);
        assert_eq!(date_get_seconds(instant, true), 56.0);
        assert_eq!(date_get_milliseconds(instant), 789.0);
        assert!(date_get_timezone_offset(instant).is_finite());
        assert!(date_get_timezone_offset(instant).fract() == 0.0);

        assert_eq!(
            date_parse_get_time(&string("Jul  1 00:00:00 2026 GMT")),
            1_782_864_000_000.0
        );
        assert_eq!(
            date_parse_get_time(&string("+010000-01-01T00:00:00.000Z")),
            253_402_300_800_000.0
        );
        assert_eq!(
            date_parse_get_time(&string("+275760-09-13T23:00:00.000+23:00")),
            8_640_000_000_000_000.0
        );
        for invalid in [
            "bogus",
            "-000000-01-01T00:00:00.000Z",
            "2024-01-01T00:00:00.000+24:00",
            "2026-13-01",
        ] {
            assert!(date_parse_get_time(&string(invalid)).is_nan(), "{invalid}");
        }
        assert!(date_get_full_year(f64::NAN, true).is_nan());
        assert!(date_get_full_year(f64::NAN, false).is_nan());
    }

    #[test]
    fn url_construction_and_getters_match_whatwg_serialization() {
        let secure = url_new(&string("HTTPS://Example.COM:443/a/../x?q=1#f"));
        assert_eq!(url_href(&secure).as_ref(), "https://example.com/x?q=1#f");
        assert_eq!(url_protocol(&secure).as_ref(), "https:");
        assert_eq!(url_host(&secure).as_ref(), "example.com");
        assert_eq!(url_hostname(&secure).as_ref(), "example.com");
        assert_eq!(url_pathname(&secure).as_ref(), "/x");

        let ipv6 = url_new(&string("http://[0:0:0:0:0:0:0:1]:8080/x"));
        assert_eq!(url_href(&ipv6).as_ref(), "http://[::1]:8080/x");
        assert_eq!(url_host(&ipv6).as_ref(), "[::1]:8080");
        assert_eq!(url_hostname(&ipv6).as_ref(), "[::1]");

        let opaque = url_new(&string("data:text/plain,hi there"));
        assert_eq!(url_href(&opaque).as_ref(), "data:text/plain,hi there");
        assert_eq!(url_pathname(&opaque).as_ref(), "text/plain,hi there");
        assert_eq!(url_host(&opaque).as_ref(), "");

        let file = url_new(&string("file:////double"));
        assert_eq!(url_href(&file).as_ref(), "file:////double");
        assert_eq!(url_pathname(&file).as_ref(), "//double");

        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            url_new(&string("not a url"))
        }))
        .err()
        .expect("an invalid URL must throw");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "TypeError");
        assert_eq!(caught_error_message(&caught).as_ref(), "Invalid URL");
    }

    #[test]
    fn url_component_getters_match_node_empty_and_default_rules() {
        // port: "" for absent AND for the scheme default; a real port 0 stays.
        assert_eq!(url_port(&url_new(&string("http://e.com/a"))).as_ref(), "");
        assert_eq!(url_port(&url_new(&string("http://e.com:80/a"))).as_ref(), "");
        assert_eq!(url_port(&url_new(&string("https://e.com:443/"))).as_ref(), "");
        assert_eq!(url_port(&url_new(&string("ftp://e.com:21/x"))).as_ref(), "");
        assert_eq!(url_port(&url_new(&string("http://e.com:8080/a"))).as_ref(), "8080");
        assert_eq!(url_port(&url_new(&string("http://e.com:0/"))).as_ref(), "0");
        assert_eq!(url_port(&url_new(&string("http://e.com:00080/"))).as_ref(), "");

        // origin: the tuple origin for the special schemes that have one,
        // the literal "null" for file: and every opaque-path scheme.
        assert_eq!(url_origin(&url_new(&string("http://e.com/a?q#f"))).as_ref(), "http://e.com");
        assert_eq!(url_origin(&url_new(&string("http://e.com:8080/"))).as_ref(), "http://e.com:8080");
        assert_eq!(url_origin(&url_new(&string("https://e.com:443/"))).as_ref(), "https://e.com");
        assert_eq!(url_origin(&url_new(&string("ftp://e.com:21/x"))).as_ref(), "ftp://e.com");
        assert_eq!(url_origin(&url_new(&string("ws://e.com:80/"))).as_ref(), "ws://e.com");
        // Userinfo is never part of an origin.
        assert_eq!(url_origin(&url_new(&string("http://u:p@e.com:99/"))).as_ref(), "http://e.com:99");
        assert_eq!(url_origin(&url_new(&string("file:///tmp/x"))).as_ref(), "null");
        assert_eq!(url_origin(&url_new(&string("mailto:x@y.com"))).as_ref(), "null");
        assert_eq!(url_origin(&url_new(&string("data:text/plain,hi"))).as_ref(), "null");
        assert_eq!(url_origin(&url_new(&string("git://e.com:9/x"))).as_ref(), "null");

        // hash: "" for no fragment AND for a bare '#' (which href keeps).
        assert_eq!(url_hash(&url_new(&string("http://e.com/p"))).as_ref(), "");
        assert_eq!(url_hash(&url_new(&string("http://e.com/p#"))).as_ref(), "");
        assert_eq!(url_hash(&url_new(&string("http://e.com/p#frag"))).as_ref(), "#frag");
        assert_eq!(url_hash(&url_new(&string("http://e.com/#a#b"))).as_ref(), "#a#b");
        assert_eq!(url_hash(&url_new(&string("http://e.com/#f?x"))).as_ref(), "#f?x");
        let bare = url_new(&string("http://e.com/#"));
        assert_eq!(url_href(&bare).as_ref(), "http://e.com/#");
        assert_eq!(url_hash(&bare).as_ref(), "");

        // username/password: percent-encoded verbatim, "" when absent — and
        // "" for the empty `user:@host` password too.
        let both = url_new(&string("http://user:pw@e.com:99/p"));
        assert_eq!(url_username(&both).as_ref(), "user");
        assert_eq!(url_password(&both).as_ref(), "pw");
        let none = url_new(&string("http://e.com/a"));
        assert_eq!(url_username(&none).as_ref(), "");
        assert_eq!(url_password(&none).as_ref(), "");
        let user_only = url_new(&string("http://user@e.com/"));
        assert_eq!(url_username(&user_only).as_ref(), "user");
        assert_eq!(url_password(&user_only).as_ref(), "");
        let empty_password = url_new(&string("http://user:@e.com/"));
        assert_eq!(url_username(&empty_password).as_ref(), "user");
        assert_eq!(url_password(&empty_password).as_ref(), "");
        assert_eq!(url_href(&empty_password).as_ref(), "http://user@e.com/");
        let encoded = url_new(&string("http://%75ser:p%40ss@e.com/"));
        assert_eq!(url_username(&encoded).as_ref(), "%75ser");
        assert_eq!(url_password(&encoded).as_ref(), "p%40ss");

        // canParse: url_new's accept/reject, answered instead of thrown.
        assert!(url_can_parse(&string("http://e.com/a")));
        assert!(url_can_parse(&string("mailto:x@y.com")));
        assert!(url_can_parse(&string("  http://e.com/  ")));
        assert!(!url_can_parse(&string("not a url")));
        assert!(!url_can_parse(&string("")));
        assert!(!url_can_parse(&string("/relative")));
        assert!(!url_can_parse(&string("http://")));
    }

    #[cfg(not(windows))]
    #[test]
    fn file_url_bridge_round_trips_paths_and_throws_node_messages() {
        let encoded = url_path_to_file_url(&string("/tmp/a b/100% légit 🌍"));
        assert_eq!(
            url_href(&encoded).as_ref(),
            "file:///tmp/a%20b/100%25%20l%C3%A9git%20%F0%9F%8C%8D"
        );
        assert_eq!(
            url_file_url_to_path(&encoded).as_ref(),
            "/tmp/a b/100% légit 🌍"
        );
        assert_eq!(
            url_string_to_path(&string("file:///tmp/a%20b/c%25d")).as_ref(),
            "/tmp/a b/c%d"
        );
        assert_eq!(
            url_string_to_path(&string("file://localhost/tmp/x")).as_ref(),
            "/tmp/x"
        );

        for (input, message) in [
            ("http://x/y", "The URL must be of scheme file"),
            (
                "file:///a%2Fb",
                "File URL path must not include encoded / characters",
            ),
        ] {
            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                url_string_to_path(&string(input))
            }))
            .expect_err("invalid file URL must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(caught_error_name(&caught).as_ref(), "TypeError");
            assert_eq!(caught_error_message(&caught).as_ref(), message);
        }
    }

    #[test]
    fn symbols_preserve_fresh_and_registered_identity() {
        let first = symbol_new(&string("key"));
        let second = symbol_new(&string("key"));
        let anonymous = symbol_new_anonymous();
        assert!(!symbol_ptr_eq(&first, &second));
        assert!(symbol_ptr_eq(&first, &first));
        assert_eq!(symbol_to_string(&first).as_ref(), "Symbol(key)");
        assert_eq!(symbol_to_string(&anonymous).as_ref(), "Symbol()");
        assert_eq!(symbol_description(&first).unwrap().as_ref(), "key");
        assert!(symbol_description(&anonymous).is_none());

        let registered = symbol_for(&string("registry.key"));
        let same = symbol_for(&string("registry.key"));
        assert!(symbol_ptr_eq(&registered, &same));
        assert_eq!(symbol_description(&registered).unwrap().as_ref(), "registry.key");
        assert_eq!(symbol_key_for(&registered).unwrap().as_ref(), "registry.key");
        assert!(symbol_key_for(&first).is_none());
    }

    #[test]
    fn search_params_parse_mutate_encode_and_sync_live_urls() {
        let params = search_params_parse(&string("a=1&b=2&a=3"));
        assert_eq!(search_params_to_string(&params).as_ref(), "a=1&b=2&a=3");
        assert_eq!(
            search_params_get(&params, &string("a")).unwrap().as_ref(),
            "1"
        );
        assert!(search_params_get(&params, &string("missing")).is_none());
        assert_eq!(
            array_join(&search_params_get_all(&params, &string("a")), &string(",")).as_ref(),
            "1,3"
        );
        search_params_append(&params, &string("c d"), &string("x y+z"));
        assert_eq!(
            search_params_to_string(&params).as_ref(),
            "a=1&b=2&a=3&c+d=x+y%2Bz"
        );
        search_params_set(&params, &string("a"), &string("9"));
        search_params_delete(&params, &string("b"));
        assert_eq!(search_params_to_string(&params).as_ref(), "a=9&c+d=x+y%2Bz");

        let encoded = search_params_parse(&string("%ff=%FF&a+b=c+d&%2b=%2B"));
        assert_eq!(
            search_params_to_string(&encoded).as_ref(),
            "%EF%BF%BD=%EF%BF%BD&a+b=c+d&%2B=%2B"
        );

        let sorted = search_params_new();
        for name in ["￻", "🚀", "", "z", "a", "z"] {
            search_params_append(&sorted, &string(name), &string("v"));
        }
        search_params_sort(&sorted);
        assert_eq!(
            (0..6)
                .map(|index| search_params_key_at(&sorted, index as f64).to_string())
                .collect::<Vec<_>>(),
            ["", "a", "z", "z", "🚀", "￻"]
        );

        let linked_url = url_new(&string("https://ex.com/p?a=1"));
        let live = url_search_params(&linked_url);
        assert!(Rc::ptr_eq(&live, &url_search_params(&linked_url)));
        search_params_append(&live, &string("b"), &string("2 3"));
        assert_eq!(url_search(&linked_url).as_ref(), "?a=1&b=2+3");
        assert_eq!(url_href(&linked_url).as_ref(), "https://ex.com/p?a=1&b=2+3");
        search_params_delete(&live, &string("a"));
        search_params_delete(&live, &string("b"));
        assert_eq!(url_search(&linked_url).as_ref(), "");
        assert_eq!(url_href(&linked_url).as_ref(), "https://ex.com/p");
    }

    #[test]
    fn search_params_pair_constructor_rejects_non_pairs() {
        let malformed = array_new(vec![array_new(vec![string("a"), string("b"), string("c")])]);
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            search_params_from_array(&malformed)
        }))
        .err()
        .expect("a non-pair URLSearchParams row must throw");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "TypeError");
        assert_eq!(
            caught_error_message(&caught).as_ref(),
            "Each query pair must be an iterable [name, value] tuple"
        );
        assert_eq!(
            caught_error_code(&caught).expect("error code").as_ref(),
            "ERR_INVALID_TUPLE"
        );
    }

    #[test]
    fn char_at_uses_javascript_utf16_indexes() {
        let value = string("Aé🎉Z");
        assert_eq!(string_char_at(&value, f64::NAN).as_ref(), "A");
        assert_eq!(string_char_at(&value, 1.9).as_ref(), "é");
        assert_eq!(string_char_at(&value, 2.0).as_ref(), "�");
        assert_eq!(string_char_at(&value, 3.0).as_ref(), "�");
        assert_eq!(string_char_at(&value, 4.0).as_ref(), "Z");
        assert_eq!(string_char_at(&value, -1.0).as_ref(), "");
        assert_eq!(string_char_at(&value, f64::INFINITY).as_ref(), "");
    }

    #[test]
    fn string_from_char_code_coerces_utf16_arrays_and_bytes() {
        let codes = array_new(vec![65.0, 0xd83d as f64, 0xde00 as f64, 0xd800 as f64]);
        assert_eq!(string_from_char_codes(&codes).as_ref(), "A😀�");
        let byte_codes = bytes_from_array::<u8>(&array_new(vec![65.0, 66.0, 255.0]));
        assert_eq!(string_from_char_code_bytes(&byte_codes).as_ref(), "ABÿ");
    }

    #[test]
    fn string_case_conversion_handles_ascii() {
        let value = string("ScriptC 42");
        assert_eq!(string_to_lower_case(&value).as_ref(), "scriptc 42");
        assert_eq!(string_to_upper_case(&value).as_ref(), "SCRIPTC 42");
        assert!(string_includes(&value, &string("iptC"), 0.0));
        assert!(!string_includes(&value, &string("iptc"), 0.0));
    }

    #[test]
    fn string_padding_counts_utf16_units() {
        let value = string("😀");
        assert_eq!(string_pad_start(&value, 3.0, &string("ab")).as_ref(), "a😀");
        assert_eq!(string_pad_end(&value, 4.0, &string("🎉")).as_ref(), "😀🎉");
        assert_eq!(string_pad_start(&value, 3.0, &string("🎉")).as_ref(), "�😀");
        assert_eq!(string_pad_start(&value, -1.0, &string("x")).as_ref(), "😀");
        assert_eq!(
            string_pad_start(&value, 10.0, &empty_string()).as_ref(),
            "😀"
        );
    }

    #[test]
    fn string_pattern_replacement_uses_ecmascript_substitutions() {
        assert_eq!(
            string_replace(
                &string("abc"),
                &string("b"),
                &string("[$&]-$`-$'-$$-$1-$<x>"),
            )
            .as_ref(),
            "a[b]-a-c-$-$1-$<x>c"
        );
        assert_eq!(
            string_replace_all(&string("aba"), &string("a"), &string("<$`|$&|$'>")).as_ref(),
            "<|a|ba>b<ab|a|>"
        );
        assert_eq!(
            string_replace_all(&string("😀"), &empty_string(), &string("-")).as_ref(),
            "-�-�-"
        );
        assert_eq!(
            string_replace_all(&string("😀"), &empty_string(), &empty_string()).as_ref(),
            "😀"
        );
        assert_eq!(
            string_replace(&empty_string(), &empty_string(), &string("x")).as_ref(),
            "x"
        );
    }

    #[test]
    fn string_at_uses_relative_utf16_indexes_and_throws_out_of_range() {
        let value = string("A🎉Z");
        assert_eq!(string_at(&value, 0.0).as_ref(), "A");
        assert_eq!(string_at(&value, -1.0).as_ref(), "Z");
        assert_eq!(string_at(&value, 1.0).as_ref(), "�");
        assert_eq!(string_at(&value, -2.0).as_ref(), "�");
        let payload =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| string_at(&value, 4.0)))
                .expect_err("out-of-range string.at must throw");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "TypeError");
        assert_eq!(
            caught_error_message(&caught).as_ref(),
            "expected string, got undefined"
        );
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
            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                regex_new("a", flags)
            }))
            .err()
            .expect("invalid RegExp flags must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(caught_error_name(&caught).as_ref(), "SyntaxError");
            assert_eq!(
                caught_error_message(&caught).as_ref(),
                format!("Invalid flags supplied to RegExp constructor '{flags}'")
            );
        }

        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            regex_new("(", "")
        }))
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
        let matched = regex_match(&subject, &regex_new(r"(a)(\d+)", "")).unwrap();
        assert_eq!(array_len(&matched), 3.0);
        assert_eq!(array_get(&matched, 0.0).as_ref(), "a12");
        assert_eq!(array_get(&matched, 1.0).as_ref(), "a");
        assert_eq!(array_get(&matched, 2.0).as_ref(), "12");
        assert_eq!(regex_search(&subject, &regex_new(r"\d+", "")), 3.0);

        let indices = array_new(Vec::new());
        let rows = regex_match_all_into(&subject, &regex_new(r"\w", "g"), &indices);
        assert_eq!(array_len(&rows), 4.0);
        assert_eq!(array_len(&indices), 4.0);
        assert_eq!(array_get(&indices, 0.0), 2.0);
        assert_eq!(array_get(&indices, 3.0), 6.0);

        let stateful = regex_new(r"\w", "g");
        assert!(regex_test(&stateful, &string("ab")));
        assert_eq!(stateful.last_index.get(), 1);
        let remaining = regex_match_all(&string("ab"), &stateful);
        assert_eq!(array_len(&remaining), 1.0);
        assert_eq!(array_get(&array_get(&remaining, 0.0), 0.0).as_ref(), "b");
        assert_eq!(stateful.last_index.get(), 1);
        let all = regex_match(&string("ab"), &stateful).unwrap();
        assert_eq!(array_len(&all), 2.0);
        assert_eq!(stateful.last_index.get(), 0);
    }

    #[test]
    fn typed_array_copying_methods_coerce_values_and_preserve_the_source() {
        let baseline = live_heap_objects();
        {
            let source = bytes_from_array::<u8>(&array_new(vec![5.0, 1.0, 4.0, 1.0, 3.0]));
            assert_eq!(bytes_join(&source, &string(",")).as_ref(), "5,1,4,1,3");
            let array_copy = bytes_to_array(&source);
            array_set(&array_copy, 0.0, 99.0);
            assert_eq!(array_get(&array_copy, 0.0), 99.0);
            assert_eq!(bytes_get(&source, 0.0), 5.0);
            let reversed = bytes_to_reversed(&source);
            assert_eq!(bytes_join(&reversed, &string(",")).as_ref(), "3,1,4,1,5");
            assert_eq!(bytes_join(&source, &string(",")).as_ref(), "5,1,4,1,3");
            assert_eq!(
                bytes_join(&bytes_with(&source, 1.0, -1.0), &string(",")).as_ref(),
                "5,255,4,1,3"
            );
            assert_eq!(
                bytes_join(&bytes_with(&source, -1.0, 260.0), &string(",")).as_ref(),
                "5,1,4,1,4"
            );
            assert_eq!(
                bytes_join(&bytes_with(&source, f64::NAN, 9.0), &string(",")).as_ref(),
                "9,1,4,1,3"
            );
            for index in [5.0, -6.0, f64::INFINITY] {
                let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    bytes_with(&source, index, 0.0)
                }))
                .err()
                .expect("an out-of-range TypedArray.with index must throw");
                let caught = caught_from_panic(payload);
                assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
                assert_eq!(
                    caught_error_message(&caught).as_ref(),
                    "Invalid typed array index"
                );
            }
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn data_views_share_typed_storage_and_recover_the_full_buffer() {
        let floats = bytes_alloc::<f32>(2.0);
        bytes_set(&floats, 0.0, 1.5);
        let float_view = data_view_new(&floats, 0.0, false, 0.0);
        assert_eq!(data_view_get(&float_view, "f32", 0.0, true), 1.5);
        data_view_set(&float_view, "f32", 4.0, 3.5, true);
        assert_eq!(bytes_get(&floats, 1.0), 3.5);

        let words = bytes_alloc::<u32>(2.0);
        bytes_set(&words, 0.0, f64::from(0x0102_0304_u32));
        let word_view = data_view_new(&words, 0.0, false, 0.0);
        assert_eq!(data_view_get(&word_view, "u32", 0.0, true), 0x0102_0304 as f64);

        let owner = bytes_alloc::<u8>(8.0);
        bytes_set(&owner, 2.0, 2.0);
        bytes_set(&owner, 3.0, 3.0);
        bytes_set(&owner, 4.0, 4.0);
        bytes_set(&owner, 6.0, 7.0);
        let window = data_view_new(&owner, 2.0, true, 3.0);
        let copied = bytes_copy(&window);
        assert_eq!(bytes_byte_offset(&copied), 0.0);
        assert_eq!(bytes_join(&copied, &string(",")).as_ref(), "2,3,4");
        let rebased = data_view_new(&window, 6.0, true, 2.0);
        assert_eq!(bytes_byte_offset(&rebased), 6.0);
        assert_eq!(data_view_get(&rebased, "u8", 0.0, false), 7.0);
    }

    #[test]
    fn buffer_comparison_and_search_match_node_ranges_and_offsets() {
        let baseline = live_heap_objects();
        {
            let source = buffer_from_string(&string("abcabcabc"), &string("utf8"));
            let same = buffer_from_string(&string("abcabcabc"), &string("utf8"));
            let greater = buffer_from_string(&string("abd"), &string("utf8"));
            let needle = buffer_from_string(&string("bc"), &string("utf8"));
            assert!(bytes_equals(&source, &same));
            assert!(!bytes_equals(&source, &greater));
            assert_eq!(
                bytes_compare(&source, &greater, 0, 0.0, 0.0, 0.0, 0.0),
                -1.0
            );
            assert_eq!(
                bytes_compare(&source, &greater, 4, 1.0, 3.0, 0.0, 2.0),
                -1.0
            );
            assert_eq!(bytes_compare(&source, &greater, 4, 1.0, 1.0, 1.0, 1.0), 0.0);
            assert_eq!(bytes_index_of(&source, &needle, f64::NAN, 1.0, true), 1.0);
            assert_eq!(bytes_index_of(&source, &needle, 4.0, 1.0, false), 4.0);
            assert_eq!(bytes_index_of(&source, &needle, -99.0, 1.0, false), -1.0);
            assert_eq!(bytes_index_of_num(&source, 354.0, 0.0, true), 1.0);
            let utf16 = buffer_from_string(&string("610062006300"), &string("hex"));
            let utf16_needle = buffer_from_string(&string("6200"), &string("hex"));
            assert_eq!(
                bytes_index_of(&utf16, &utf16_needle, f64::NAN, 2.0, true),
                2.0
            );

            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                bytes_compare(&source, &greater, 1, -1.0, 0.0, 0.0, 0.0)
            }))
            .expect_err("a negative compare offset must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
            assert_eq!(
                caught_error_code(&caught).expect("error code").as_ref(),
                "ERR_OUT_OF_RANGE"
            );
            assert_eq!(
                caught_error_message(&caught).as_ref(),
                "The value of \"targetStart\" is out of range. It must be >= 0 && <= 9007199254740991. Received -1"
            );
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn buffer_mutation_methods_preserve_node_clamping_and_chaining() {
        let baseline = live_heap_objects();
        {
            let filled = bytes_alloc::<u8>(5.0);
            let chained = bytes_fill_str(&filled, &string("ab"), &string("utf8"), 0, 0.0, 0.0);
            assert!(filled.ptr_eq(&chained));
            assert_eq!(bytes_to_string(&filled, &string("utf8")).as_ref(), "ababa");

            let source = buffer_from_string(&string("abcdef"), &string("utf8"));
            let target = bytes_alloc::<u8>(4.0);
            assert_eq!(bytes_copy_into(&source, &target, 3, 1.0, 2.9, 5.9), 3.0);
            assert_eq!(
                bytes_to_string(&target, &string("hex")).as_ref(),
                "00636465"
            );

            let swapped = buffer_from_string(&string("01020304"), &string("hex"));
            assert!(swapped.ptr_eq(&bytes_swap(&swapped, 2)));
            assert_eq!(
                bytes_to_string(&swapped, &string("hex")).as_ref(),
                "02010403"
            );

            let written = bytes_alloc::<u8>(5.0);
            assert_eq!(
                bytes_write_str(&written, &string("h😀x"), &string("utf8"), 0.0, 4.0, true,),
                1.0
            );
            assert_eq!(
                bytes_to_string(&written, &string("hex")).as_ref(),
                "6800000000"
            );

            let parts = array_new(vec![
                buffer_from_string(&string("0102"), &string("hex")),
                buffer_from_string(&string("03"), &string("hex")),
            ]);
            assert_eq!(
                bytes_to_string(&buffer_concat_len(&parts, 5.0), &string("hex")).as_ref(),
                "0102030000"
            );
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn operating_system_identity_values_are_available() {
        assert!(!os_type().is_empty());
        assert!(!os_release().is_empty());
        assert!(os_totalmem() > 0.0);
        assert!(!os_user_name().is_empty());
        assert!(!os_user_homedir().is_empty());
    }

    #[test]
    fn net_auto_select_family_attempt_timeout_validates_and_clamps() {
        net_set_auto_select_family_attempt_timeout(300.0);
        assert_eq!(net_get_auto_select_family_attempt_timeout(), 300.0);
        net_set_auto_select_family_attempt_timeout(1.0);
        assert_eq!(net_get_auto_select_family_attempt_timeout(), 10.0);

        for (value, message) in [
            (
                -0.0,
                "The value of \"value\" is out of range. It must be >= 1 && <= 2147483647. Received -0",
            ),
            (
                1.5,
                "The value of \"value\" is out of range. It must be an integer. Received 1.5",
            ),
            (
                f64::NAN,
                "The value of \"value\" is out of range. It must be an integer. Received NaN",
            ),
            (
                f64::INFINITY,
                "The value of \"value\" is out of range. It must be an integer. Received Infinity",
            ),
            (
                2_147_483_648.0,
                "The value of \"value\" is out of range. It must be >= 1 && <= 2147483647. Received 2147483648",
            ),
        ] {
            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                net_set_auto_select_family_attempt_timeout(value)
            }))
            .expect_err("an invalid attempt timeout must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
            assert_eq!(caught_error_code(&caught).as_deref(), Some("ERR_OUT_OF_RANGE"));
            assert_eq!(caught_error_message(&caught).as_ref(), message);
        }
        net_set_auto_select_family_attempt_timeout(250.0);
    }

    #[test]
    fn buffer_numeric_methods_follow_node_coercion_and_error_order() {
        let baseline = live_heap_objects();
        {
            let fixed = bytes_alloc::<u8>(8.0);
            assert_eq!(bytes_write_num(&fixed, "u32be", 1.9, 0.0), 4.0);
            assert_eq!(bytes_read_num(&fixed, "u32be", 0.0), 1.0);
            assert_eq!(bytes_write_num(&fixed, "u16le", f64::NAN, 0.0), 2.0);
            assert_eq!(bytes_read_num(&fixed, "u16le", 0.0), 0.0);

            let variable = bytes_alloc::<u8>(6.0);
            assert_eq!(
                bytes_write_num_var(&variable, "ule", 4_328_719_365.0, 0.0, 5.0),
                5.0
            );
            assert_eq!(
                bytes_to_string(&variable, &string("hex")).as_ref(),
                "050403020100"
            );
            assert_eq!(
                bytes_read_num_var(&variable, "ule", 0.0, 5.0),
                4_328_719_365.0
            );
            bytes_write_num_var(&variable, "ibe", -2.0, 0.0, 3.0);
            assert_eq!(bytes_read_num_var(&variable, "ibe", 0.0, 3.0), -2.0);

            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                bytes_read_num(&fixed, "u16be", 4_294_967_297.0)
            }))
            .expect_err("an out-of-range numeric offset must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(
                caught_error_code(&caught).expect("error code").as_ref(),
                "ERR_OUT_OF_RANGE"
            );
            assert_eq!(
                caught_error_message(&caught).as_ref(),
                "The value of \"offset\" is out of range. It must be >= 0 and <= 6. Received 4_294_967_297"
            );
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn buffer_encodings_cover_aliases_dynamic_errors_and_utf16_lengths() {
        let baseline = live_heap_objects();
        {
            let value = string("hé€😀x");
            let latin1 = buffer_from_string(&value, &string("latin1"));
            assert_eq!(
                bytes_to_string(&latin1, &string("hex")).as_ref(),
                "68e9ac3d0078"
            );
            let utf16 = buffer_from_string(&value, &string("utf16le"));
            assert_eq!(
                bytes_to_string(&utf16, &string("utf16le")).as_ref(),
                value.as_ref()
            );
            assert_eq!(buffer_byte_length_string(&value, &string("latin1")), 6.0);
            assert_eq!(buffer_byte_length_string(&value, &string("utf16le")), 12.0);
            assert!(buffer_is_encoding(&string("BASE64URL")));
            assert!(buffer_is_encoding(&string("ucs-2")));
            assert!(!buffer_is_encoding(&string("utf16")));

            let raw = buffer_from_string(&string("68e9807fff"), &string("hex"));
            assert_eq!(
                bytes_to_string_checked(&raw, &string("BINARY")).as_ref(),
                "hé\u{80}\u{7f}ÿ"
            );
            assert_eq!(
                bytes_to_string_checked_range(&raw, &string("wat"), 2.0, 2.0).as_ref(),
                ""
            );
            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                bytes_to_string_checked(&raw, &string("wat"))
            }))
            .expect_err("an unknown dynamic encoding must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(
                caught_error_code(&caught).expect("error code").as_ref(),
                "ERR_UNKNOWN_ENCODING"
            );
            assert_eq!(
                caught_error_message(&caught).as_ref(),
                "Unknown encoding: wat"
            );
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn string_decoder_buffers_only_incomplete_encoding_units() {
        let baseline = live_heap_objects();
        {
            let utf8 = string("utf8");
            let first = bytes_from_elements(vec![0xe2, 0x82]);
            assert_eq!(string_decoder_write(&utf8, 0.0, &first).as_ref(), "");
            let pending = string_decoder_next(&utf8, 0.0, &first);
            let second = bytes_from_elements(vec![0xac, 0x61]);
            assert_eq!(string_decoder_write(&utf8, pending, &second).as_ref(), "€a");
            assert_eq!(string_decoder_next(&utf8, pending, &second), 0.0);

            let utf16 = string("utf16le");
            let odd = buffer_from_string(&string("61"), &string("hex"));
            assert_eq!(string_decoder_write(&utf16, 0.0, &odd).as_ref(), "");
            let pending = string_decoder_next(&utf16, 0.0, &odd);
            let rest = buffer_from_string(&string("006200"), &string("hex"));
            assert_eq!(string_decoder_write(&utf16, pending, &rest).as_ref(), "ab");

            let base64 = string("base64");
            let grouped = bytes_from_elements(vec![1, 2, 3, 4]);
            assert_eq!(
                string_decoder_write(&base64, 0.0, &grouped).as_ref(),
                "AQID"
            );
            let pending = string_decoder_next(&base64, 0.0, &grouped);
            assert_eq!(string_decoder_end(&base64, pending).as_ref(), "BA==");
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn scalar_json_stringification_escapes_strings_and_normalizes_non_finite_numbers() {
        assert_eq!(json_stringify(&f64::NAN).as_ref(), "null");
        assert_eq!(json_stringify(&f64::INFINITY).as_ref(), "null");
        assert_eq!(json_stringify(&-0.0).as_ref(), "0");
        assert_eq!(json_stringify(&true).as_ref(), "true");
        assert_eq!(
            json_stringify(&string("quote \" slash \\\n\t\u{0007}")).as_ref(),
            "\"quote \\\" slash \\\\\\n\\t\\u0007\""
        );
        assert_eq!(json_stringify(&string("héllo 😀")).as_ref(), "\"héllo 😀\"");
    }

    #[test]
    fn json_unicode_escape_split_by_multibyte_scalar_is_a_syntax_error() {
        // "\u123é": the é lands inside the 4-byte escape window, which must
        // surface as a catchable syntax error, never a runtime panic.
        for input in ["\"\\u123é\"", "\"\\u12g4\""] {
            let Err(error) = json_parse_node(&string(input)) else {
                panic!("{input} parsed instead of erroring");
            };
            assert!(
                error.contains("invalid unicode escape"),
                "unexpected error for {input}: {error}"
            );
        }
        let parsed = json_parse_node(&string("\"\\u0041\"")).expect("valid escape");
        assert!(matches!(parsed, JsonNode::String(value) if value.as_ref() == "A"));
    }

    #[test]
    fn bitwise_conversions_follow_ecmascript_width() {
        assert_eq!(bit_not(0.0), -1.0);
        assert_eq!(shift_right_unsigned(-1.0, 1.0), 2_147_483_647.0);
    }

    #[test]
    fn filesystem_errors_use_node_style_lowercase_descriptions() {
        assert_eq!(
            fs_error_text(&std::io::Error::from(std::io::ErrorKind::NotFound)),
            "no such file or directory"
        );
        assert_eq!(
            fs_error_text(&std::io::Error::from(std::io::ErrorKind::AlreadyExists)),
            "file already exists"
        );
        assert_eq!(
            fs_error_text(&std::io::Error::from(std::io::ErrorKind::IsADirectory)),
            "illegal operation on a directory"
        );
    }

    #[test]
    fn filesystem_creation_modes_reject_non_integer_and_out_of_range_values() {
        for mode in [-1.0, 1.5, f64::NAN, f64::INFINITY, 4_294_967_296.0] {
            let payload =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fs_creation_mode(mode)))
                    .expect_err("an invalid creation mode must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
            assert_eq!(
                caught_error_code(&caught).as_deref(),
                Some("ERR_OUT_OF_RANGE")
            );
        }
        assert_eq!(fs_creation_mode(0o600 as f64), 0o600);
        assert_eq!(fs_creation_mode(4_294_967_295.0), u32::MAX);
    }

    #[test]
    fn file_handle_aliases_share_close_state_and_last_drop_closes() {
        let baseline = live_heap_objects();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the test clock must follow the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "scriptc-runtime-file-handle-{}-{suffix}",
            std::process::id()
        ));
        std::fs::write(&path, b"handle").expect("the FileHandle fixture must be writable");
        let path_string: JsString = Rc::from(path.to_string_lossy().as_ref());

        {
            let handle = file_handle_open(&path_string, &string("r"), 0o666 as f64);
            let alias = handle.clone();
            let fd = file_handle_fd(&handle);
            assert!(fd >= 0.0);
            assert_eq!(file_handle_fd(&alias), fd);
            assert_eq!(stats_size(&file_handle_stat(&handle)), 6.0);
            file_handle_close(&alias);
            assert_eq!(file_handle_fd(&handle), -1.0);
            file_handle_close(&handle);
        }

        {
            let handle = file_handle_open(&path_string, &string("r"), 0o666 as f64);
            let fd = file_handle_fd(&handle) as i32;
            assert!(OPEN_FILES.with(|files| files.borrow().contains_key(&fd)));
            drop(handle);
            assert!(!OPEN_FILES.with(|files| files.borrow().contains_key(&fd)));
        }

        std::fs::remove_file(path).expect("the FileHandle fixture must be removable");
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn file_handle_data_operations_preserve_descriptor_position() {
        let baseline = live_heap_objects();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the test clock must follow the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "scriptc-runtime-file-handle-data-{}-{suffix}",
            std::process::id()
        ));
        std::fs::write(&path, b"abcdef").expect("the FileHandle fixture must be writable");
        let path_string: JsString = Rc::from(path.to_string_lossy().as_ref());

        {
            let handle = file_handle_open(&path_string, &string("r+"), 0o666 as f64);
            let current = bytes_alloc::<u8>(3.0);
            assert_eq!(
                file_handle_read(&handle, &current, 0.0, -1.0, -1.0, true),
                3.0
            );
            assert_eq!(bytes_to_string(&current, &string("utf8")).as_ref(), "abc");

            let positioned = bytes_alloc::<u8>(2.0);
            assert_eq!(
                file_handle_read(&handle, &positioned, 0.0, 2.0, 4.0, false),
                2.0
            );
            assert_eq!(bytes_to_string(&positioned, &string("utf8")).as_ref(), "ef");
            assert_eq!(
                file_handle_write_str(&handle, &string("XY"), -1.0, &string("utf8")),
                2.0
            );
            let source = buffer_from_string(&string("QZ"), &string("utf8"));
            assert_eq!(
                file_handle_write_bytes(&handle, &source, 0.0, 2.0, 1.0, false),
                2.0
            );
            assert_eq!(
                file_handle_read_file(&handle, &string("utf8")).as_ref(),
                "f"
            );
            assert_eq!(
                std::fs::read(&path).expect("fixture must be readable"),
                b"aQZXYf"
            );
            file_handle_close(&handle);
        }

        std::fs::remove_file(path).expect("the FileHandle fixture must be removable");
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn file_handle_invalid_argument_inspection_matches_node() {
        assert_eq!(inspected_argument("bad"), "'bad'");
        assert_eq!(inspected_argument("w'bad"), "\"w'bad\"");
        assert_eq!(inspected_argument("w\"bad"), "'w\"bad'");
        assert_eq!(inspected_argument("w'\"bad"), "`w'\"bad`");
        assert_eq!(inspected_argument("w\\bad"), "'w\\\\bad'");
        assert_eq!(inspected_argument("w\nbad"), "'w\\nbad'");
        assert_eq!(inspected_argument("w\u{0080}bad"), "'w\\x80bad'");
        assert_eq!(inspected_argument("w\0not-a-flag"), "'w\\x00not-a-flag'");
        let long = inspected_argument(&"x".repeat(256));
        assert_eq!(long.encode_utf16().count(), 131);
        assert!(long.starts_with('\''));
        assert!(long.ends_with("..."));
    }

    #[test]
    fn process_environment_overlay_updates_reads_and_inherited_children() {
        let name = string("SCRIPTC_RUNTIME_ENV_OVERLAY_TEST");
        let value = string("written");
        process_env_unset(&name);
        assert_eq!(process_env_get(&name), None);
        process_env_set(&name, &value);
        assert_eq!(process_env_get(&name).as_deref(), Some("written"));
        let pairs = process_env_pairs();
        assert!(pairs.with(|pairs| pairs.elements.as_chunks::<2>().0.iter().any(|pair| {
            pair[0].as_ref() == name.as_ref() && pair[1].as_ref() == value.as_ref()
        })));

        #[cfg(unix)]
        {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "printf %s \"$SCRIPTC_RUNTIME_ENV_OVERLAY_TEST\""]);
            process_env_apply(&mut command);
            let output = command.output().expect("the environment child must run");
            assert_eq!(output.stdout, b"written");
        }

        process_env_unset(&name);
        assert_eq!(process_env_get(&name), None);
        assert!(!process_env_pairs().with(|pairs| pairs.elements.as_chunks::<2>().0
            .iter()
            .any(|pair| pair[0].as_ref() == name.as_ref())));
    }

    #[test]
    fn rename_workers_progress_and_checkpoint_each_callback() {
        init();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("the test clock must follow the Unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "scriptc-runtime-rename-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).expect("the rename fixture directory must be creatable");
        let source_a = dir.join("a.txt");
        let source_b = dir.join("b.txt");
        let destination_a = dir.join("a-done.txt");
        let destination_b = dir.join("b-done.txt");
        std::fs::write(&source_a, b"a").expect("the first rename fixture must be writable");
        std::fs::write(&source_b, b"b").expect("the second rename fixture must be writable");

        let callbacks = Rc::new(Cell::new(0));
        let ticks = Rc::new(Cell::new(0));
        let microtasks = Rc::new(Cell::new(0));
        let callback =
            |callbacks: Rc<Cell<i32>>, ticks: Rc<Cell<i32>>, microtasks: Rc<Cell<i32>>| {
                Box::new(move |error: Option<JsError>| {
                    assert!(error.is_none());
                    callbacks.set(callbacks.get() + 1);
                    if callbacks.get() == 2 {
                        assert_eq!(ticks.get(), 1);
                        assert_eq!(microtasks.get(), 1);
                    }
                    let next_ticks = ticks.clone();
                    process_next_tick(Box::new(move || next_ticks.set(next_ticks.get() + 1)));
                    let queued_microtasks = microtasks.clone();
                    timer_queue_microtask(Box::new(move || {
                        queued_microtasks.set(queued_microtasks.get() + 1);
                    }));
                }) as Box<dyn FnOnce(Option<JsError>)>
            };

        let source_a_string: JsString = Rc::from(source_a.to_string_lossy().as_ref());
        let source_b_string: JsString = Rc::from(source_b.to_string_lossy().as_ref());
        let destination_a_string: JsString = Rc::from(destination_a.to_string_lossy().as_ref());
        let destination_b_string: JsString = Rc::from(destination_b.to_string_lossy().as_ref());
        fs_rename_async(
            &source_a_string,
            &destination_a_string,
            callback(callbacks.clone(), ticks.clone(), microtasks.clone()),
        );
        fs_rename_async(
            &source_b_string,
            &destination_b_string,
            callback(callbacks.clone(), ticks.clone(), microtasks.clone()),
        );

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while (source_a.exists() || source_b.exists()) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(!source_a.exists() && !source_b.exists());
        assert_eq!(callbacks.get(), 0);
        run_event_loop();
        assert_eq!(callbacks.get(), 2);
        assert_eq!(ticks.get(), 2);
        assert_eq!(microtasks.get(), 2);

        let abandoned_source = dir.join("abandoned.txt");
        let abandoned_destination = dir.join("abandoned-done.txt");
        std::fs::write(&abandoned_source, b"cleanup")
            .expect("the abandoned rename fixture must be writable");
        let abandoned_called = Rc::new(Cell::new(false));
        let abandoned_callback = abandoned_called.clone();
        fs_rename_async(
            &Rc::from(abandoned_source.to_string_lossy().as_ref()),
            &Rc::from(abandoned_destination.to_string_lossy().as_ref()),
            Box::new(move |_| abandoned_callback.set(true)),
        );
        finish();
        assert!(abandoned_destination.exists());
        assert!(!abandoned_called.get());
        std::fs::remove_dir_all(dir).expect("the rename fixture directory must be removable");
    }

    #[test]
    fn first_event_loop_checkpoint_runs_module_microtasks_before_ticks() {
        init();
        let order = Rc::new(RefCell::new(Vec::new()));
        let tick_order = order.clone();
        process_next_tick(Box::new(move || tick_order.borrow_mut().push("tick")));
        let microtask_order = order.clone();
        timer_queue_microtask(Box::new(move || {
            microtask_order.borrow_mut().push("microtask");
            let nested_order = microtask_order.clone();
            process_next_tick(Box::new(move || nested_order.borrow_mut().push("nested tick")));
        }));

        run_event_loop();
        assert_eq!(*order.borrow(), ["microtask", "tick", "nested tick"]);
        finish();
    }

    #[test]
    fn first_commonjs_checkpoint_runs_ticks_before_microtasks() {
        init();
        let order = Rc::new(RefCell::new(Vec::new()));
        let tick_order = order.clone();
        process_next_tick(Box::new(move || tick_order.borrow_mut().push("tick")));
        let microtask_order = order.clone();
        timer_queue_microtask(Box::new(move || {
            microtask_order.borrow_mut().push("microtask");
            let nested_order = microtask_order.clone();
            process_next_tick(Box::new(move || nested_order.borrow_mut().push("nested tick")));
        }));

        run_event_loop_commonjs();
        assert_eq!(*order.borrow(), ["tick", "microtask", "nested tick"]);
        finish();
    }
