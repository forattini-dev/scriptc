use super::*;

#[test]
fn native_errors_compare_by_reference_identity() {
    let original = error_new("TypeError", string("same"));
    let alias = original.clone();
    let distinct = error_new("TypeError", string("same"));
    assert_eq!(original, alias);
    assert_ne!(original, distinct);
    error_set_message(&alias, string("changed"));
    assert_eq!(original, alias);
    assert_eq!(error_message(&original), string("changed"));
}

#[test]
fn matching_causes_and_dom_properties_do_not_merge_error_identity() {
    let cause = caught_value(string("reason"));
    let original = error_new_cause("Error", string("same"), cause.clone());
    let distinct = error_new_cause("Error", string("same"), cause);
    assert_eq!(original, original.clone());
    assert_ne!(original, distinct);
    let dom = dom_exception_new(string("same"), string("AbortError"), None);
    assert_eq!(dom, dom.clone());
    assert_ne!(dom, error_dom_clone(&dom));
}
