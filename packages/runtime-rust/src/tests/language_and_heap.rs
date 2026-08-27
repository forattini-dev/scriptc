    #[test]
    fn same_value_distinguishes_signed_zero_and_matches_nan() {
        assert!(number_same_value(f64::NAN, f64::NAN));
        assert!(!number_same_value(0.0, -0.0));
        assert!(number_same_value(-0.0, -0.0));
    }

    #[test]
    fn math_min_max_match_javascript_nan_and_signed_zero_rules() {
        assert!(math_max(f64::NAN, 1.0).is_nan());
        assert!(math_min(1.0, f64::NAN).is_nan());
        assert!(math_max(-0.0, 0.0).is_sign_positive());
        assert!(math_max(-0.0, -0.0).is_sign_negative());
        assert!(math_min(-0.0, 0.0).is_sign_negative());
        assert!(math_min(0.0, 0.0).is_sign_positive());

        let values = array_new(vec![3.0, -0.0, 0.0, 9.0]);
        assert_eq!(math_max_array(&values), 9.0);
        assert_eq!(math_min_array(&values), -0.0);
        assert_eq!(math_max_array(&array_new(Vec::new())), f64::NEG_INFINITY);
        assert_eq!(math_min_array(&array_new(Vec::new())), f64::INFINITY);
        assert!(math_max_array(&array_new(vec![1.0, f64::NAN])).is_nan());
    }

    #[test]
    fn math_round_matches_javascript_ties_and_signed_zero() {
        assert_eq!(math_round(1.5), 2.0);
        assert_eq!(math_round(-1.5), -1.0);
        assert_eq!(math_round(0.499_999_999_999_999_94), 0.0);
        assert!(math_round(-0.3).is_sign_negative());
        assert!(math_round(-0.0).is_sign_negative());
        assert!(math_round(f64::NAN).is_nan());
        assert_eq!(math_round(f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn math_sign_and_pow_preserve_ecmascript_edges() {
        assert!(math_sign(-0.0).is_sign_negative());
        assert_eq!(math_sign(-4.0), -1.0);
        assert_eq!(math_sign(4.0), 1.0);
        assert!(math_sign(f64::NAN).is_nan());
        assert!(math_pow(1.0, f64::INFINITY).is_nan());
        assert!(math_pow(-1.0, f64::NEG_INFINITY).is_nan());
        assert_eq!(math_pow(2.0, 10.0), 1024.0);
        assert!(math_pow(-0.0, -3.0).is_infinite());
        assert!(math_pow(-0.0, -3.0).is_sign_negative());
    }

    #[test]
    fn fixed_number_formatting_uses_the_exact_binary_value() {
        assert_eq!(number_to_fixed(1.005, 2.0).as_ref(), "1.00");
        assert_eq!(number_to_fixed(2.55, 1.0).as_ref(), "2.5");
        assert_eq!(number_to_fixed(0.5, 0.0).as_ref(), "1");
        assert_eq!(number_to_fixed(-2.5, 0.0).as_ref(), "-3");
        assert_eq!(number_to_fixed(-0.0, 3.0).as_ref(), "0.000");
        assert_eq!(number_to_fixed(1e21, 2.0).as_ref(), "1e+21");
        assert_eq!(number_to_fixed(1.0, 5.0).as_ref(), "1.00000");
    }

    #[test]
    fn intl_en_us_formats_shortest_decimal_with_default_grouping() {
        for (value, expected) in [
            (1.0005, "1.001"),
            (7.995, "7.995"),
            (999.9995, "1,000"),
            (0.0005, "0.001"),
            (-0.0005, "-0.001"),
            (0.00049, "0"),
            (1e23, "100,000,000,000,000,000,000,000"),
            (9_007_199_254_740_993.0, "9,007,199,254,740,992"),
            (-0.0, "-0"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "∞"),
            (f64::NEG_INFINITY, "-∞"),
        ] {
            assert_eq!(intl_number_format_en_us(value).as_ref(), expected);
        }
    }

    #[test]
    fn exponential_number_formatting_reuses_shortest_ecmascript_digits() {
        for (value, expected) in [
            (1234.5678, "1.2345678e+3"),
            (0.00001, "1e-5"),
            (100.0, "1e+2"),
            (-7.25, "-7.25e+0"),
            (0.1 + 0.2, "3.0000000000000004e-1"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            assert_eq!(number_to_exponential(value).as_ref(), expected);
        }
        assert_eq!(number_to_exponential(0.0).as_ref(), "0e+0");
        assert_eq!(number_to_exponential(-0.0).as_ref(), "0e+0");
    }

    #[test]
    fn precision_number_formatting_rounds_the_exact_binary_value() {
        for (value, precision, expected) in [
            (1.25, 2.0, "1.3"),
            (2.25, 2.0, "2.3"),
            (9.95, 2.0, "9.9"),
            (9.99, 2.0, "10"),
            (1234.5678, 2.0, "1.2e+3"),
            (1234.5678, 8.0, "1234.5678"),
            (0.000123, 2.0, "0.00012"),
            (1e21, 3.0, "1.00e+21"),
            (1e-7, 3.0, "1.00e-7"),
            (f64::from_bits(1), 5.0, "4.9407e-324"),
            (f64::MAX, 5.0, "1.7977e+308"),
            (-0.0, 3.0, "0.00"),
            (f64::NAN, 2.0, "NaN"),
            (f64::INFINITY, 0.0, "Infinity"),
        ] {
            assert_eq!(number_to_precision(value, precision).as_ref(), expected);
        }
    }

    #[test]
    fn radix_number_formatting_matches_v8_digit_boundaries() {
        for (value, radix, expected) in [
            (255.0, 16.0, "ff"),
            (255.0, 2.0, "11111111"),
            (511.0, 8.0, "777"),
            (12345.0, 36.0, "9ix"),
            (-255.0, 16.0, "-ff"),
            (0.5, 2.0, "0.1"),
            (
                0.1,
                2.0,
                "0.0001100110011001100110011001100110011001100110011001101",
            ),
            (0.1, 3.0, "0.0022002200220022002200220022002201"),
            (1.0 / 3.0, 16.0, "0.55555555555554"),
            (std::f64::consts::PI, 36.0, "3.53i5ab8p5f"),
            (
                1.0000000000000002,
                3.0,
                "1.000000000000000000000000000000001",
            ),
            (
                9_007_199_254_740_992.0,
                3.0,
                "1121202011211211122211100012101112",
            ),
            (0.0, 2.0, "0"),
            (-0.0, 2.0, "0"),
            (f64::NAN, 16.0, "NaN"),
            (f64::INFINITY, 16.0, "Infinity"),
        ] {
            assert_eq!(number_to_radix_string(value, radix).as_ref(), expected);
        }
        let minimum = number_to_radix_string(f64::from_bits(1), 2.0);
        assert_eq!(minimum.len(), 1076);
        assert!(minimum.starts_with("0."));
        assert!(minimum.ends_with('1'));
    }

    #[test]
    fn parse_float_uses_the_longest_javascript_decimal_prefix() {
        assert_eq!(number_parse_float(&string("  -2.5e-2tail")), -0.025);
        assert_eq!(number_parse_float(&string(".5")), 0.5);
        assert_eq!(number_parse_float(&string("1e")), 1.0);
        assert_eq!(number_parse_float(&string("0x10")), 0.0);
        assert_eq!(number_parse_float(&string("+Infinity!")), f64::INFINITY);
        assert!(number_parse_float(&string("inf")).is_nan());
        assert!(number_parse_float(&string("")).is_nan());
        assert!(number_parse_float(&string("-0")).is_sign_negative());
    }

    #[test]
    fn string_to_number_matches_javascript_whole_span_grammar() {
        assert_eq!(number_from_string(&string("\u{a0}\u{feff}  \n")), 0.0);
        assert_eq!(number_from_string(&string("+.5")), 0.5);
        assert_eq!(number_from_string(&string("5.e3")), 5000.0);
        assert_eq!(number_from_string(&string("0x20000000000001")), 2_f64.powi(53));
        assert_eq!(number_from_string(&string("0x20000000000002")), 2_f64.powi(53) + 2.0);
        assert_eq!(number_from_string(&string("0xffffffffffffffff")), u64::MAX as f64);
        assert_eq!(number_from_string(&string("2.5e-324")).to_bits(), 1);
        assert_eq!(number_from_string(&string("2e-324")).to_bits(), 0);
        assert!(number_from_string(&string("-0")).is_sign_negative());
        assert!(number_from_string(&string("-0x10")).is_nan());
        assert!(number_from_string(&string("1e")).is_nan());
        assert!(number_from_string(&string("12px")).is_nan());
        assert!(number_from_string(&string(&format!("0x{}", "f".repeat(300)))).is_infinite());
    }

    #[test]
    fn uri_codecs_match_ecmascript_sets_utf8_and_errors() {
        let unchanged = string("AZaz09-_.!~*'()");
        let encoded = string_encode_uri_component(&unchanged);
        assert!(Rc::ptr_eq(&unchanged, &encoded));
        assert_eq!(
            string_encode_uri_component(&string("a b;c/d?é€💩")).as_ref(),
            "a%20b%3Bc%2Fd%3F%C3%A9%E2%82%AC%F0%9F%92%A9"
        );
        assert_eq!(
            string_encode_uri(&string("a b;c/d?e:f@g&h=i+j$k,l#m")).as_ref(),
            "a%20b;c/d?e:f@g&h=i+j$k,l#m"
        );
        assert_eq!(
            string_decode_uri_component(&string("mix é %C3%A9 %23%2f")).as_ref(),
            "mix é é #/"
        );
        for (encoded, decoded) in [
            ("%C2%80", "\u{80}"),
            ("%E0%A0%80", "\u{800}"),
            ("%ED%9F%BF", "\u{d7ff}"),
            ("%EE%80%80", "\u{e000}"),
            ("%F0%90%80%80", "\u{10000}"),
            ("%F4%8F%BF%BF", "\u{10ffff}"),
        ] {
            assert_eq!(
                string_decode_uri_component(&string(encoded)).as_ref(),
                decoded
            );
        }

        for malformed in [
            "%",
            "%2",
            "%zz",
            "%C3",
            "%C3x",
            "%C3%2F",
            "%E0%80%80",
            "%ED%A0%80",
            "%F4%90%80%80",
            "%FF",
            "%80",
        ] {
            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                string_decode_uri_component(&string(malformed))
            }))
            .err()
            .expect("malformed URI escapes must throw");
            let caught = caught_from_panic(payload);
            assert_eq!(caught_error_name(&caught).as_ref(), "URIError");
            assert_eq!(caught_error_message(&caught).as_ref(), "URI malformed");
        }
    }

    #[test]
    fn dom_exception_and_base64_follow_web_platform_rules() {
        let cause = string("cause");
        let error = dom_exception_new(
            string("bad input"),
            string("InvalidCharacterError"),
            Some(caught_value(cause.clone())),
        );
        assert!(error_is_class(&error, "DOMException"));
        assert!(error_is_class(&error, "Error"));
        assert!(!error_is_class(&error, "InvalidCharacterError"));
        assert_eq!(error_dom_code(&error), 5.0);
        assert!(error_dom_has_cause(&error));
        assert_eq!(error_dom_cause::<JsString>(&error).as_ref(), Some(&cause));
        let identity = error_identity(&error);
        assert_eq!(error_identity(&error.clone()), identity);
        let cloned = error_dom_clone(&error);
        assert_ne!(error_identity(&cloned), identity);
        assert_eq!(error_name(&cloned).as_ref(), "InvalidCharacterError");
        assert_eq!(error_message(&cloned).as_ref(), "bad input");
        assert!(!error_dom_has_cause(&cloned));

        for value in ["", "a", "ab", "abc", "binary\0\u{1}\u{fe}data"] {
            let value = string(value);
            assert_eq!(string_atob(&string_btoa(&value)), value);
        }
        assert_eq!(string_atob(&string("  Y\tW\nJj\r ")).as_ref(), "abc");
        assert_eq!(string_atob(&string("YWJjZA==")).as_ref(), "abcd");

        for malformed in ["a", "我要抛错！"] {
            let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                string_atob(&string(malformed))
            }))
            .err()
            .expect("invalid base64 must throw");
            let caught = caught_from_panic(payload);
            assert!(caught_is_error_class(&caught, "DOMException"));
            let error = caught_error_value(&caught);
            assert_eq!(error_name(&error).as_ref(), "InvalidCharacterError");
            assert_eq!(error_dom_code(&error), 5.0);
            assert_eq!(
                error_message(&error).as_ref(),
                "The string to be decoded is not correctly encoded."
            );
        }

        let payload = std::panic::catch_unwind(|| string_base64_missing_argument())
            .err()
            .expect("missing base64 input must throw");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "TypeError");
        assert_eq!(
            caught_error_code(&caught).as_deref(),
            Some("ERR_MISSING_ARGS")
        );
    }

    #[test]
    fn string_well_formed_methods_follow_the_utf8_storage_invariant() {
        for value in [string(""), string("plain"), string("é€"), string("😀")] {
            assert!(string_is_well_formed(&value));
            assert!(Rc::ptr_eq(&value, &string_to_well_formed(&value)));
        }
    }

    #[test]
    fn string_last_index_of_and_substring_use_utf16_indices() {
        let value = string("😀ab😀ab");
        assert_eq!(string_last_index_of(&value, &string("😀")), 4.0);
        assert_eq!(string_last_index_of(&value, &empty_string()), 8.0);
        assert_eq!(string_last_index_of(&value, &string("x")), -1.0);
        assert_eq!(string_substring(&value, 6.0, 2.0).as_ref(), "ab😀");
        assert_eq!(string_substring(&value, -3.0, 2.0).as_ref(), "😀");
        assert!(string_compare_utf16(&string("😀"), &string("\u{e000}")) < 0);
        assert_eq!(string_compare_utf16(&string("same"), &string("same")), 0);
    }

    #[test]
    fn string_raw_interleaves_available_substitutions() {
        let raw = array_new(vec![string("a"), string("b"), string("c")]);
        let substitutions = array_new(vec![string("1"), string("2"), string("dropped")]);
        assert_eq!(string_raw(&raw, &substitutions).as_ref(), "a1b2c");
        assert_eq!(
            string_raw(&array_new(vec![string("only")]), &substitutions).as_ref(),
            "only"
        );
    }

    #[test]
    fn math_random_stays_in_javascript_range_and_varies() {
        let first = math_random();
        let mut varied = false;
        for _ in 0..128 {
            let value = math_random();
            assert!((0.0..1.0).contains(&value));
            varied |= value != first;
        }
        assert!(varied);
    }

    #[test]
    fn indexed_string_records_use_javascript_property_order() {
        let record = map_new();
        for (key, value) in [("name", "n"), ("10", "ten"), ("2", "two"), ("tail", "t")] {
            map_set_by(&record, string(key), string(value), |left, right| {
                left.as_ref() == right.as_ref()
            });
        }
        let keys = map_string_keys_js_order(&record);
        assert_eq!(array_get(&keys, 0.0).as_ref(), "2");
        assert_eq!(array_get(&keys, 1.0).as_ref(), "10");
        assert_eq!(array_get(&keys, 2.0).as_ref(), "name");
        assert_eq!(array_get(&keys, 3.0).as_ref(), "tail");
        assert_eq!(
            json_stringify(&record).as_ref(),
            r#"{"2":"two","10":"ten","name":"n","tail":"t"}"#
        );
        assert_eq!(
            json_stringify_indented(&record, "  ").as_ref(),
            "{\n  \"2\": \"two\",\n  \"10\": \"ten\",\n  \"name\": \"n\",\n  \"tail\": \"t\"\n}"
        );
    }

    #[test]
    fn arrays_preserve_aliasing_and_release_acyclic_values() {
        let baseline = live_heap_objects();
        {
            let array = array_new(vec![1.0, 2.0]);
            let alias = array.clone();
            array_set(&alias, 1.0, 9.0);
            assert_eq!(array_get(&array, 1.0), 9.0);
            assert!(array_ptr_eq(&array, &alias));
            assert_eq!(array_unshift(&array, vec![-1.0, 0.0]), 4.0);
            assert_eq!(array_unshift_from(&array, &array), 8.0);
            assert_eq!(array_get(&array, 0.0), -1.0);
            assert_eq!(array_get(&array, 4.0), -1.0);
            let reversed = array_reverse(&array);
            assert!(array_ptr_eq(&array, &reversed));
            assert_eq!(array_get(&array, 0.0), 9.0);
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn dynamic_conversion_guard_rejects_cycles_and_recovers_after_unwind() {
        let outer = dyn_from_enter(41);
        let nested = dyn_from_enter(42);
        drop(nested);
        assert!(std::panic::catch_unwind(|| dyn_from_enter(41)).is_err());
        drop(outer);
        drop(dyn_from_enter(41));
    }

    #[test]
    fn template_strings_preserve_per_site_identity() {
        let first = template_strings("first-site", &["a", "b"]);
        let same = template_strings("first-site", &["a", "b"]);
        let other = template_strings("other-site", &["a", "b"]);
        assert!(array_ptr_eq(&first, &same));
        assert!(!array_ptr_eq(&first, &other));
        assert_eq!(array_get(&first, 0.0).as_ref(), "a");
        assert_eq!(array_get(&first, 1.0).as_ref(), "b");
        template_strings_clear();
    }

    #[test]
    fn array_ranges_follow_javascript_indices_and_preserve_reference_identity() {
        let baseline = live_heap_objects();
        {
            let values = array_new(vec![10.0, 20.0, 30.0, 40.0, 50.0]);
            let middle = array_slice(&values, -4.0, -2.0);
            assert_eq!(middle.with(|data| data.elements.clone()), vec![20.0, 30.0]);
            let fractional = array_slice(&values, 1.7, 3.2);
            assert_eq!(
                fractional.with(|data| data.elements.clone()),
                vec![20.0, 30.0]
            );

            let removed = array_splice(&values, -2.0, 1.8);
            assert_eq!(removed.with(|data| data.elements.clone()), vec![40.0]);
            assert_eq!(
                values.with(|data| data.elements.clone()),
                vec![10.0, 20.0, 30.0, 50.0]
            );
            assert_eq!(array_shift(&values), 10.0);
            assert_eq!(
                values.with(|data| data.elements.clone()),
                vec![20.0, 30.0, 50.0]
            );
            assert_eq!(array_len(&array_splice(&values, 0.0, f64::NAN)), 0.0);
            assert_eq!(array_len(&array_splice(&values, 1.0, f64::INFINITY)), 2.0);

            let child = array_new(vec![1.0]);
            let references = array_new(vec![child.clone(), child.clone()]);
            let copied = array_slice(&references, 0.0, 1.0);
            let moved = array_splice(&references, 0.0, 1.0);
            assert!(array_get(&copied, 0.0).ptr_eq(&child));
            assert!(array_get(&moved, 0.0).ptr_eq(&child));
            assert!(array_shift(&references).ptr_eq(&child));
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn array_copying_methods_preserve_sources_identity_and_range_errors() {
        let baseline = live_heap_objects();
        {
            let source = array_new(vec![1.0, 2.0, 3.0, 4.0]);
            let reversed = array_to_reversed(&source);
            assert_eq!(
                reversed.with(|data| data.elements.clone()),
                vec![4.0, 3.0, 2.0, 1.0]
            );
            assert_eq!(
                source.with(|data| data.elements.clone()),
                vec![1.0, 2.0, 3.0, 4.0]
            );

            let items = array_new(vec![8.0, 9.0]);
            let spliced = array_to_spliced(&source, 1.0, 2.0, &items);
            assert_eq!(
                spliced.with(|data| data.elements.clone()),
                vec![1.0, 8.0, 9.0, 4.0]
            );
            assert_eq!(
                array_to_spliced(&source, f64::NAN, 0.0, &array_new(vec![6.0]))
                    .with(|data| data.elements.clone()),
                vec![6.0, 1.0, 2.0, 3.0, 4.0]
            );

            assert_eq!(
                array_with(&source, -1.0, 9.0).with(|data| data.elements.clone()),
                vec![1.0, 2.0, 3.0, 9.0]
            );
            assert_eq!(
                array_with(&source, 1.9, 7.0).with(|data| data.elements.clone()),
                vec![1.0, 7.0, 3.0, 4.0]
            );
            assert_eq!(
                array_with(&source, f64::NAN, 6.0).with(|data| data.elements.clone()),
                vec![6.0, 2.0, 3.0, 4.0]
            );
            for (index, message) in [
                (4.0, "Invalid index : 4"),
                (-5.0, "Invalid index : -5"),
                (f64::INFINITY, "Invalid index : Infinity"),
            ] {
                let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    array_with(&source, index, 0.0)
                }))
                .err()
                .expect("an out-of-range Array.with index must throw");
                let caught = caught_from_panic(payload);
                assert_eq!(caught_error_name(&caught).as_ref(), "RangeError");
                assert_eq!(caught_error_message(&caught).as_ref(), message);
            }

            let first = array_new(vec![1.0]);
            let second = array_new(vec![2.0]);
            let references = array_new(vec![first.clone(), second.clone()]);
            let reversed_refs = array_to_reversed(&references);
            assert!(array_get(&reversed_refs, 0.0).ptr_eq(&second));
            let inserted = array_new(vec![3.0]);
            let spliced_refs =
                array_to_spliced(&references, 1.0, 0.0, &array_new(vec![inserted.clone()]));
            assert!(array_get(&spliced_refs, 0.0).ptr_eq(&first));
            assert!(array_get(&spliced_refs, 1.0).ptr_eq(&inserted));
            let replacement = array_new(vec![4.0]);
            let with_ref = array_with(&references, 0.0, replacement.clone());
            assert!(array_get(&with_ref, 0.0).ptr_eq(&replacement));
            assert!(array_get(&with_ref, 1.0).ptr_eq(&second));
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn captured_cells_share_mutations_and_trace_heap_values() {
        let baseline = live_heap_objects();
        {
            let number = cell_new(1.0);
            let alias = number.clone();
            cell_set(&alias, 9.0);
            assert_eq!(cell_get(&number), 9.0);

            let array = array_new(vec![2.0]);
            let captured = cell_new(array.clone());
            drop(array);
            assert_eq!(array_get(&cell_get(&captured), 0.0), 2.0);
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn tdz_reads_unwind_as_typed_catchable_reference_errors() {
        let cell = cell_empty::<JsString>();
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            cell_get_tdz(&cell, "answer")
        }))
        .expect_err("an empty TDZ cell must unwind");
        let caught = caught_from_panic(payload);
        assert!(caught_is_error(&caught));
        assert_eq!(caught_error_name(&caught).as_ref(), "ReferenceError");
        assert_eq!(
            caught_error_message(&caught).as_ref(),
            "Cannot access 'answer' before initialization"
        );

        cell_set(&cell, string("ready"));
        assert_eq!(cell_get_tdz(&cell, "answer").as_ref(), "ready");
    }

    #[test]
    fn runtime_fences_unwind_as_catchable_coded_errors() {
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            throw_error_code("deferred construct".to_owned(), "SC1031")
        }))
        .expect_err("a runtime fence must unwind");
        let caught = caught_from_panic(payload);
        assert_eq!(caught_error_name(&caught).as_ref(), "Error");
        assert_eq!(caught_error_message(&caught).as_ref(), "deferred construct");
        assert_eq!(
            error_code(&caught_error_value(&caught)).unwrap().as_ref(),
            "SC1031"
        );
    }

    #[test]
    fn catch_conversion_rethrows_non_javascript_panics() {
        let payload = std::panic::catch_unwind(|| {
            std::panic::resume_unwind(Box::new("internal bug".to_owned()))
        })
        .expect_err("the synthetic internal panic must unwind");
        let propagated =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| caught_from_panic(payload)));
        assert!(propagated.is_err());
    }

    #[test]
    fn caught_primitive_values_narrow_and_stringify() {
        let number = caught_value(12.5_f64);
        assert!(caught_is::<f64>(&number));
        assert!(!caught_is::<bool>(&number));
        assert_eq!(caught_narrow::<f64>(&number), 12.5);
        assert_eq!(caught_to_string(&number).as_ref(), "12.5");

        let boolean = caught_value(true);
        assert!(caught_is::<bool>(&boolean));
        assert!(caught_narrow::<bool>(&boolean));
        assert_eq!(caught_to_string(&boolean).as_ref(), "true");

        let text = caught_value(string("reason"));
        assert!(caught_is::<JsString>(&text));
        assert_eq!(caught_narrow::<JsString>(&text).as_ref(), "reason");
        assert_eq!(caught_to_string(&text).as_ref(), "reason");

        let typed_error = error_new("TypeError", string("bad"));
        assert!(error_is_class(&typed_error, "TypeError"));
        assert!(error_is_class(&typed_error, "Error"));
        assert!(!error_is_class(&typed_error, "RangeError"));
        assert_eq!(error_to_string(&typed_error).as_ref(), "TypeError: bad");
        assert_eq!(error_to_string_parts("", "message").as_ref(), "message");
        assert_eq!(error_to_string_parts("Error", "").as_ref(), "Error");

        let error = caught_value(typed_error);
        assert_eq!(caught_to_string(&error).as_ref(), "TypeError: bad");
    }

    #[test]
    fn collector_breaks_self_and_mutual_cycles_without_unsafe() {
        let baseline = live_heap_objects();

        let self_cycle = Gc::new(Link { next: None });
        self_cycle.with_mut(|link| link.next = Some(self_cycle.clone()));
        drop(self_cycle);

        let left = Gc::new(Link { next: None });
        let right = Gc::new(Link { next: None });
        left.with_mut(|link| link.next = Some(right.clone()));
        right.with_mut(|link| link.next = Some(left.clone()));
        drop(left);
        drop(right);

        assert_eq!(live_heap_objects(), baseline + 3);
        assert_eq!(collect_cycles(), 3);
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn collector_keeps_a_cycle_with_an_outside_owner() {
        let baseline = live_heap_objects();
        let rooted = Gc::new(Link { next: None });
        rooted.with_mut(|link| link.next = Some(rooted.clone()));

        let released_alias = rooted.clone();
        drop(released_alias);
        assert_eq!(collect_cycles(), 0);
        assert_eq!(live_heap_objects(), baseline + 1);

        drop(rooted);
        assert_eq!(collect_cycles(), 1);
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn weak_heap_handles_upgrade_without_retaining_the_object() {
        let baseline = live_heap_objects();
        let node = Gc::new(Link { next: None });
        let weak = node.downgrade();

        let upgraded = weak.upgrade().expect("live heap object");
        assert!(upgraded.ptr_eq(&node));
        drop(upgraded);
        drop(node);

        assert!(weak.upgrade().is_none());
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promises_queue_reactions_and_settle_only_once() {
        let baseline = live_heap_objects();
        let promise = promise_new::<f64>();
        let events = Rc::new(RefCell::new(Vec::new()));

        let pending_events = events.clone();
        promise_then(
            &promise,
            Box::new(move |outcome| pending_events.borrow_mut().push(promise_unwrap(outcome))),
        );
        assert!(promise_fulfill(&promise, 7.0));
        assert!(!promise_fulfill(&promise, 9.0));
        assert!(events.borrow().is_empty());

        let settled_events = events.clone();
        promise_then(
            &promise,
            Box::new(move |outcome| settled_events.borrow_mut().push(promise_unwrap(outcome))),
        );
        run_event_loop();
        assert_eq!(events.borrow().as_slice(), &[7.0, 7.0]);

        let rejected = promise_new::<f64>();
        let rejected_events = events.clone();
        promise_then(
            &rejected,
            Box::new(move |outcome| match outcome {
                Ok(_) => panic!("scriptc: rejected promise fulfilled"),
                Err(reason) => rejected_events.borrow_mut().push(
                    if caught_error_name(&reason).as_ref() == "TypeError" {
                        -1.0
                    } else {
                        -2.0
                    },
                ),
            }),
        );
        promise_run_segment(&rejected, || throw_type_error("async failure".to_owned()));
        run_event_loop();
        assert_eq!(events.borrow().as_slice(), &[7.0, 7.0, -1.0]);

        drop(promise);
        drop(rejected);
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promise_rejections_wait_for_handlers_until_the_microtask_checkpoint() {
        init();
        let baseline = live_heap_objects();

        let unhandled = promise_rejected::<f64>(caught_value(string("unhandled")));
        assert!(!had_unhandled_rejection());
        run_event_loop();
        assert!(had_unhandled_rejection());
        drop(unhandled);

        init();
        let handled = promise_rejected::<f64>(caught_value(string("handled")));
        let saw_rejection = Rc::new(Cell::new(false));
        let observed = saw_rejection.clone();
        promise_then(
            &handled,
            Box::new(move |outcome| observed.set(matches!(outcome, Err(_)))),
        );
        run_event_loop();
        assert!(saw_rejection.get());
        assert!(!had_unhandled_rejection());
        drop(handled);

        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promise_rejection_events_preserve_identity_and_late_catches() {
        init();
        let baseline = live_heap_objects();
        let unhandled_count = Rc::new(Cell::new(0));
        let handled_count = Rc::new(Cell::new(0));
        let catch_count = Rc::new(Cell::new(0));

        let handled_observer = handled_count.clone();
        promise_set_rejection_handled_handler(Some(Rc::new(move |_| {
            handled_observer.set(handled_observer.get() + 1);
        })));
        let unhandled_observer = unhandled_count.clone();
        let catch_observer = catch_count.clone();
        promise_set_unhandled_rejection_handler(Some(Rc::new(move |reason, promise| {
            assert_eq!(caught_to_string(&reason).as_ref(), "late");
            unhandled_observer.set(unhandled_observer.get() + 1);
            let caught = catch_observer.clone();
            let _ = promise_handle_catch(
                &promise,
                Box::new(move |reason| {
                    assert_eq!(caught_to_string(&reason).as_ref(), "late");
                    caught.set(caught.get() + 1);
                }),
            );
        })));

        let promise = promise_rejected::<f64>(caught_value(string("late")));
        let identity = promise.identity();
        let handle = promise_to_handle(&promise);
        assert_eq!(promise_handle_identity(&handle), identity);
        run_event_loop();
        assert_eq!(unhandled_count.get(), 1);
        assert_eq!(handled_count.get(), 1);
        assert_eq!(catch_count.get(), 1);
        assert!(!had_unhandled_rejection());

        drop(handle);
        drop(promise);
        finish();
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promise_map_transforms_fulfillments_and_forwards_rejections() {
        let baseline = live_heap_objects();
        {
            let fulfilled = promise_resolved(2.0_f64);
            let mapped = promise_map(&fulfilled, |value| number_to_string(value * 3.0));
            let values = Rc::new(RefCell::new(Vec::new()));
            let observed = values.clone();
            promise_then(
                &mapped,
                Box::new(move |outcome| observed.borrow_mut().push(promise_unwrap(outcome))),
            );

            let rejected = promise_rejected::<f64>(caught_value(string("reason")));
            let forwarded = promise_map(&rejected, |value| value + 1.0);
            let saw_rejection = Rc::new(Cell::new(false));
            let observed_rejection = saw_rejection.clone();
            promise_then(
                &forwarded,
                Box::new(move |outcome| {
                    observed_rejection.set(matches!(outcome, Err(reason) if caught_to_string(&reason).as_ref() == "reason"));
                }),
            );

            run_event_loop();
            assert_eq!(values.borrow().as_slice(), &[string("6")]);
            assert!(saw_rejection.get());
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn finish_releases_pending_promise_reaction_cycles() {
        init();
        let baseline = live_heap_objects();
        let first = promise_new::<()>();
        let second = promise_new::<()>();
        let first_target = first.clone();
        promise_then(&second, Box::new(move |_| {
            let _ = promise_fulfill(&first_target, ());
        }));
        let second_target = second.clone();
        promise_then(&first, Box::new(move |_| {
            let _ = promise_fulfill(&second_target, ());
        }));
        drop(first);
        drop(second);
        assert_eq!(live_heap_objects(), baseline + 2);
        finish();
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promise_from_sync_fulfills_values_and_converts_throws_to_rejections() {
        let baseline = live_heap_objects();
        {
            let fulfilled = promise_from_sync(|| 42.0_f64);
            let fulfilled_values = Rc::new(RefCell::new(Vec::new()));
            let observed_values = fulfilled_values.clone();
            promise_then(
                &fulfilled,
                Box::new(move |outcome| observed_values.borrow_mut().push(promise_unwrap(outcome))),
            );

            let rejected = promise_from_sync::<f64, _>(|| {
                throw_type_error("sync operation failed".to_owned())
            });
            let rejection = Rc::new(RefCell::new(None));
            let observed_rejection = rejection.clone();
            promise_then(
                &rejected,
                Box::new(move |outcome| {
                    if let Err(reason) = outcome {
                        *observed_rejection.borrow_mut() = Some(caught_to_string(&reason));
                    }
                }),
            );

            run_event_loop();
            assert_eq!(fulfilled_values.borrow().as_slice(), &[42.0]);
            assert_eq!(
                rejection.borrow().as_deref(),
                Some("TypeError: sync operation failed")
            );
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promise_race_add_adapts_heterogeneous_fulfillments() {
        let baseline = live_heap_objects();
        {
            let result = promise_new::<JsString>();
            let number = promise_new::<f64>();
            let text = promise_new::<JsString>();
            promise_race_add(&result, &number, number_to_string);
            promise_race_add(&result, &text, |value| value);

            let values = Rc::new(RefCell::new(Vec::new()));
            let observed = values.clone();
            promise_then(
                &result,
                Box::new(move |outcome| observed.borrow_mut().push(promise_unwrap(outcome))),
            );

            assert!(promise_fulfill(&number, 7.0));
            assert!(promise_fulfill(&text, string("late")));
            run_event_loop();
            assert_eq!(values.borrow().as_slice(), &[string("7")]);
        }
        assert_eq!(live_heap_objects(), baseline);
    }

    #[test]
    fn promise_all_preserves_order_and_rejects_on_the_first_failure() {
        let baseline = live_heap_objects();
        {
            let first = promise_new::<f64>();
            let second = promise_new::<f64>();
            let entries = array_new(vec![first.clone(), second.clone()]);
            let combined = promise_all(&entries);
            let values = Rc::new(RefCell::new(Vec::new()));
            let observed = values.clone();
            promise_then(
                &combined,
                Box::new(move |outcome| {
                    let array = promise_unwrap(outcome);
                    observed
                        .borrow_mut()
                        .extend([array_get(&array, 0.0), array_get(&array, 1.0)]);
                }),
            );

            assert!(promise_fulfill(&second, 2.0));
            assert!(promise_fulfill(&first, 1.0));
            run_event_loop();
            assert_eq!(values.borrow().as_slice(), &[1.0, 2.0]);

            let rejected_entry = promise_new::<f64>();
            let ignored_entry = promise_new::<f64>();
            let rejected_entries = array_new(vec![rejected_entry.clone(), ignored_entry.clone()]);
            let rejected_all = promise_all(&rejected_entries);
            let rejected = Rc::new(Cell::new(false));
            let observed_rejection = rejected.clone();
            promise_then(
                &rejected_all,
                Box::new(move |outcome| {
                    observed_rejection.set(matches!(outcome, Err(reason)
                        if caught_error_name(&reason).as_ref() == "TypeError"));
                }),
            );
            promise_run_segment(&rejected_entry, || {
                throw_type_error("Promise.all failure".to_owned())
            });
            assert!(promise_fulfill(&ignored_entry, 9.0));
            run_event_loop();
            assert!(rejected.get());
        }
        assert_eq!(live_heap_objects(), baseline);
    }
