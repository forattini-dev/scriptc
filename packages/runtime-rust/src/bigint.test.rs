use super::*;

fn decode_hex(value: &str) -> String {
    assert!(value.len().is_multiple_of(2));
    let bytes = (0..value.len()).step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).expect("oracle hex"))
        .collect::<Vec<_>>();
    String::from_utf8(bytes).expect("oracle UTF-8")
}

fn evaluate(op: &str, a: &str, b: &str) -> String {
    if op == "parse" { return bigint_to_string(&bigint_from_string(&JsString::from(a))).to_string(); }
    if op == "fromNumber" { return bigint_to_string(&bigint_from_number(a.parse().unwrap())).to_string(); }
    let a = bigint_from_string(&JsString::from(a));
    match op {
        "number" => return crate::format_number(bigint_to_number(&a)),
        "truthy" => return bigint_truthy(&a).to_string(),
        "json" => return crate::json_stringify(&a).to_string(),
        "radix" => return bigint_to_string_radix(&a, b.parse().unwrap()).to_string(),
        "cmpNumber" => return match bigint_cmp_number(&a, b.parse().unwrap()) {
            Some(Ordering::Less) => "-1", Some(Ordering::Equal) => "0",
            Some(Ordering::Greater) => "1", None => "unordered",
        }.to_owned(),
        _ => {}
    }
    let result = match op {
        "neg" => bigint_neg(&a), "not" => bigint_not(&a),
        "uint" => bigint_as_uint_n(b.parse().unwrap(), &a),
        "int" => bigint_as_int_n(b.parse().unwrap(), &a),
        _ => {
            let b = bigint_from_string(&JsString::from(b));
            match op {
                "add" => bigint_add(&a, &b), "sub" => bigint_sub(&a, &b),
                "mul" => bigint_mul(&a, &b), "div" => bigint_div(&a, &b),
                "rem" => bigint_rem(&a, &b), "and" => bigint_and(&a, &b),
                "or" => bigint_or(&a, &b), "xor" => bigint_xor(&a, &b),
                "shl" => bigint_shl(&a, &b), "shr" => bigint_shr(&a, &b),
                "pow" => bigint_pow(&a, &b),
                "cmp" => return match a.cmp(&b) { Ordering::Less => "-1", Ordering::Equal => "0", Ordering::Greater => "1" }.to_owned(),
                _ => panic!("unknown oracle operation: {op}"),
            }
        }
    };
    bigint_to_string(&result).to_string()
}

fn check_vectors(target: &'static str, vectors: &str) {
    crate::init();
    let previous = crate::target_config();
    crate::target_configure(crate::TargetConfig { runtime_id: target, ..previous });
    for (index, line) in vectors.lines().enumerate() {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 4);
        let a = decode_hex(fields[1]);
        let b = decode_hex(fields[2]);
        let expected = decode_hex(fields[3]);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| evaluate(fields[0], &a, &b)));
        let actual = match result {
            Ok(value) => format!("ok:{value}"),
            Err(panic) => {
                let caught = crate::caught_from_panic(panic);
                format!("error:{}:{}", crate::caught_error_name(&caught), crate::caught_error_message(&caught))
            }
        };
        assert_eq!(actual, expected, "row {}: {}({a:?}, {b:?})", index + 1, fields[0]);
    }
    crate::target_configure(previous);
    crate::finish();
}

#[test]
fn immutable_bigint_clones_share_storage_and_arithmetic_does_not_mutate() {
    let a = bigint_from_string(&JsString::from("9007199254740993"));
    let alias = a.clone();
    assert!(Rc::ptr_eq(&a.0, &alias.0));
    let sum = bigint_add(&a, &bigint_from_bool(true));
    assert!(!Rc::ptr_eq(&a.0, &sum.0));
    assert_eq!(bigint_to_string(&alias).as_ref(), "9007199254740993");
    assert_eq!(bigint_to_string(&sum).as_ref(), "9007199254740994");
    assert_eq!(display_bigint(&a), "9007199254740993n");
}

#[test]
fn native_bigint_matches_node24_vectors() { check_vectors("node24", include_str!("tests/bigint-oracle.tsv")); }
#[test]
fn native_bigint_matches_node26_vectors() { check_vectors("node26", include_str!("tests/bigint-oracle-node26.tsv")); }
#[test]
fn native_bigint_matches_bun_vectors() { check_vectors("bun", include_str!("tests/bigint-oracle-bun.tsv")); }
