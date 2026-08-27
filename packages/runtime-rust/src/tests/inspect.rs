#[test]
fn error_inspection_is_stackless_and_preserves_codes() {
    let plain = error_new("Error", string("boom"));
    assert_eq!(inspect_error(&plain, 0.0, 2.0).as_ref(), "[Error: boom]");

    let coded = error_new_code("Error", string("boom"), "E_BOOM");
    assert_eq!(
        inspect_error(&coded, 0.0, 2.0).as_ref(),
        "[Error: boom] { code: 'E_BOOM' }"
    );
    assert_eq!(inspect_error(&coded, 3.0, 2.0).as_ref(), "[Error]");
}
