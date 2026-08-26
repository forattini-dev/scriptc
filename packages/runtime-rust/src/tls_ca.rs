#[derive(Clone)]
struct TlsTrust {
    use_bundled: bool,
    pem_certificates: Vec<String>,
}

thread_local! {
    // None is Node's original default store. Some, including Some([]),
    // is the live replacement installed by setDefaultCACertificates.
    static TLS_DEFAULT_CA_CERTIFICATES: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
}

fn tls_split_pem_certificates(input: &str) -> Vec<String> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let mut certificates = Vec::new();
    let mut offset = 0;
    while let Some(start_relative) = input[offset..].find(BEGIN) {
        let start = offset + start_relative;
        let body = start + BEGIN.len();
        let Some(end_relative) = input[body..].find(END) else {
            break;
        };
        let end = body + end_relative + END.len();
        let mut pem = input[start..end].to_string();
        pem.push('\n');
        certificates.push(pem);
        offset = end;
    }
    certificates
}

fn tls_read_ca_bundle(paths: &[&str]) -> Vec<String> {
    for path in paths {
        if let Ok(bundle) = std::fs::read_to_string(path) {
            let certificates = tls_split_pem_certificates(&bundle);
            if !certificates.is_empty() {
                return certificates;
            }
        }
    }
    Vec::new()
}

fn tls_bundled_ca_certificates() -> Vec<String> {
    static CACHE: OnceLock<Vec<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            tls_read_ca_bundle(&[
                "/etc/ssl/certs/ca-certificates.crt",
                "/etc/pki/tls/certs/ca-bundle.crt",
                "/etc/ssl/ca-bundle.pem",
                "/etc/ssl/cert.pem",
            ])
        })
        .clone()
}

fn tls_extra_ca_certificates() -> Vec<String> {
    let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS") else {
        return Vec::new();
    };
    let Ok(bundle) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    tls_split_pem_certificates(&bundle)
}

fn tls_default_trust() -> TlsTrust {
    TLS_DEFAULT_CA_CERTIFICATES.with(|certificates| match &*certificates.borrow() {
        None => TlsTrust {
            use_bundled: true,
            pem_certificates: Vec::new(),
        },
        Some(certificates) => TlsTrust {
            use_bundled: false,
            pem_certificates: certificates.clone(),
        },
    })
}

fn tls_explicit_trust(ca: String) -> TlsTrust {
    if ca.is_empty() {
        tls_default_trust()
    } else {
        TlsTrust {
            use_bundled: false,
            pem_certificates: vec![ca],
        }
    }
}

fn tls_ca_array(values: Vec<String>) -> JsArray<JsString> {
    array_new(values.into_iter().map(|value| string(&value)).collect())
}

pub fn tls_ca_get(kind: &JsString) -> JsArray<JsString> {
    match kind.as_ref() {
        "default" => TLS_DEFAULT_CA_CERTIFICATES.with(|certificates| {
            tls_ca_array(
                certificates
                    .borrow()
                    .clone()
                    .unwrap_or_else(tls_bundled_ca_certificates),
            )
        }),
        "bundled" => tls_ca_array(tls_bundled_ca_certificates()),
        "system" => tls_ca_array(tls_bundled_ca_certificates()),
        "extra" => tls_ca_array(tls_extra_ca_certificates()),
        value => throw_type_error_code(
            format!("The argument 'type' is invalid. Received '{value}'"),
            "ERR_INVALID_ARG_VALUE",
        ),
    }
}

pub fn tls_ca_root() -> JsArray<JsString> {
    tls_ca_array(tls_bundled_ca_certificates())
}

pub fn tls_ca_set_default(certificates: &JsArray<JsString>) {
    let mut unique = Vec::<String>::new();
    let length = array_len(certificates) as usize;
    for index in 0..length {
        let certificate = array_get(certificates, index as f64).to_string();
        if !unique.iter().any(|existing| existing == &certificate) {
            unique.push(certificate);
        }
    }
    if !unique.is_empty()
        && !unique
            .iter()
            .any(|certificate| !tls_split_pem_certificates(certificate).is_empty())
    {
        throw_error_code(
            "Failed to parse certificate".to_string(),
            "ERR_CRYPTO_OPERATION_FAILED",
        );
    }
    TLS_DEFAULT_CA_CERTIFICATES.with(|stored| *stored.borrow_mut() = Some(unique));
}

fn tls_ca_finish() {
    TLS_DEFAULT_CA_CERTIFICATES.with(|stored| *stored.borrow_mut() = None);
}
