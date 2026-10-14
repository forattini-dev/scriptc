use super::*;

#[test]
fn bundled_enumeration_and_handshakes_share_all_pinned_roots() {
    tls_ca_finish();
    assert_eq!(tls_bundled_ca_certificates().len(), 145);
    assert_eq!(tls_roots(&tls_default_trust()).unwrap().len(), 145);
    assert_eq!(array_len(&tls_ca_root()), 145.0);
    tls_ca_finish();
}

#[test]
fn empty_default_replacement_does_not_reintroduce_bundled_roots() {
    tls_ca_finish();
    tls_ca_set_default(&array_new(Vec::<JsString>::new()));
    assert_eq!(tls_roots(&tls_default_trust()).unwrap().len(), 0);
    assert_eq!(array_len(&tls_ca_get(&string("default"))), 0.0);
    assert_eq!(array_len(&tls_ca_root()), 145.0);
    tls_ca_finish();
    assert_eq!(tls_roots(&tls_default_trust()).unwrap().len(), 145);
    tls_ca_finish();
}
