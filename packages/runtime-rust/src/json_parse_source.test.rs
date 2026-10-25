#[test]
fn json_parse_source_preserves_primitive_spelling_and_duplicates() {
    let text =
        string(r#" {"x":1.00e+02,"x":9007199254740993,"nested":[-0,true,null,"\u0061",{}]} "#);
    let (node, source) = json_parse_with_source(&text).unwrap();
    assert!(matches!(node, JsonNode::Object(_)));
    let JsonSourceTree::Object(entries) = source else {
        panic!("object source")
    };
    let JsonSourceTree::Primitive(first) = &entries[0].1 else {
        panic!("first token")
    };
    let JsonSourceTree::Primitive(last) = &entries[1].1 else {
        panic!("last token")
    };
    assert_eq!(first, "1.00e+02");
    assert_eq!(last, "9007199254740993");
    let JsonSourceTree::Array(items) = &entries[2].1 else {
        panic!("array source")
    };
    for (item, expected) in items.iter().zip(["-0", "true", "null", r#""\u0061""#]) {
        let JsonSourceTree::Primitive(token) = item else {
            panic!("primitive token")
        };
        assert_eq!(token, expected);
    }
    assert!(matches!(&items[4], JsonSourceTree::Object(entries) if entries.is_empty()));
}

#[test]
fn json_parse_source_maps_original_utf16_after_raw_lone_surrogates() {
    let units = [
        0x5b, 0x22, 0xd800, 0x22, 0x2c, 0x22, 0xd83d, 0xde00, 0x22, 0x2c, 0x31, 0x5d,
    ];
    let (_, source) = json_parse_with_source(&JsString::from_utf16(&units)).unwrap();
    let JsonSourceTree::Array(items) = source else {
        panic!("array source")
    };
    for (item, expected) in items
        .iter()
        .zip([&units[1..4], &units[5..9], &units[10..11]])
    {
        let JsonSourceTree::Primitive(token) = item else {
            panic!("primitive token")
        };
        assert_eq!(token.encode_utf16().collect::<Vec<_>>(), expected);
    }
}

#[test]
fn json_parse_source_validates_complete_input() {
    for text in ["1 2", "[1,]", r#"{"a":1,}"#, "01", r#""\x20""#, "[true"] {
        assert!(json_parse_with_source(&string(text)).is_err(), "{text}");
    }
}
