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

#[test]
fn user_error_styling_follows_node_improve_stack() {
    // The inherited default: the declaration name prefixes it.
    assert_eq!(
        inspect_user_error_parts(&string("Error"), &string("boom"), "Tmp").as_ref(),
        "[Tmp [Error]: boom]"
    );
    // An overridden name wins as-is.
    assert_eq!(
        inspect_user_error_parts(&string("AppError"), &string("boom"), "AppError").as_ref(),
        "[AppError: boom]"
    );
    assert_eq!(
        inspect_user_error_parts(&string("Other"), &string("boom"), "Tmp").as_ref(),
        "[Other: boom]"
    );
    // A non-"Error" name never gets the bracket form.
    assert_eq!(
        inspect_user_error_parts(&string("ProtoName"), &string("boom"), "Tmp").as_ref(),
        "[ProtoName: boom]"
    );
    // The declaration name subsumes a shorter "Error" suffix (`MyError`
    // over the inherited `Error`): the prefix spelling replaces it.
    assert_eq!(
        inspect_user_error_parts(&string("Error"), &string("boom"), "MyError").as_ref(),
        "[MyError: boom]"
    );
    // Builtin subclasses inherit the same defaulting.
    assert_eq!(
        inspect_user_error_parts(&string("TypeError"), &string("boom"), "Tmp").as_ref(),
        "[Tmp [TypeError]: boom]"
    );
    // The declaration name equal to the override: plain.
    assert_eq!(
        inspect_user_error_parts(&string("Tmp"), &string("boom"), "Tmp").as_ref(),
        "[Tmp: boom]"
    );
    // Own name "Error" styles through the declaration when the
    // declaration CONTAINS the name ("AppError" over "Error" subsumes)
    // and brackets when it does not ("Tmp [Error]").
    assert_eq!(
        inspect_user_error_parts(&string("Error"), &string("boom"), "AppError").as_ref(),
        "[AppError: boom]"
    );
    // Empty message renders the name-only bracket.
    assert_eq!(
        inspect_user_error_parts(&string("AppError"), &string(""), "AppError").as_ref(),
        "[AppError]"
    );
    // An empty name does not end with "Error": it prints as-is.
    assert_eq!(
        inspect_user_error_parts(&string(""), &string("boom"), "Tmp").as_ref(),
        "[: boom]"
    );
}

#[test]
fn user_error_parts_indent_multiline_messages_by_frames() {
    assert_eq!(
        inspect_user_error_parts(&string("AppError"), &string("line1\nline2"), "AppError").as_ref(),
        "[AppError: line1\nline2]"
    );
    inspect_begin(1.0);
    assert_eq!(
        inspect_user_error_parts(&string("AppError"), &string("line1\nline2"), "AppError").as_ref(),
        "[AppError: line1\n  line2]"
    );
    let _ = inspect_end(&string(""), &string("{"), &string("}"), 1.0, false, false);
    assert_eq!(
        inspect_user_error_parts(&string("AppError"), &string("line1\nline2"), "AppError").as_ref(),
        "[AppError: line1\nline2]"
    );
}
