/// The parts of a peer certificate represented by the native TLS boundary.
/// Name attributes retain repetitions because Node exposes those as arrays.
pub struct TlsPeerCertificate {
    pub subject: Vec<(JsString, Vec<JsString>)>,
    pub issuer: Vec<(JsString, Vec<JsString>)>,
    pub valid_from: JsString,
    pub valid_to: JsString,
    pub fingerprint: JsString,
    pub fingerprint256: JsString,
    pub fingerprint512: JsString,
    pub serial_number: JsString,
    pub ca: bool,
    pub raw: Vec<u8>,
}

fn tls_peer_name(
    name: &x509_parser::x509::X509Name<'_>,
) -> Result<Vec<(JsString, Vec<JsString>)>, String> {
    let mut result: Vec<(JsString, Vec<JsString>)> = Vec::new();
    for attribute in name.iter_attributes() {
        let oid = attribute.attr_type().to_id_string();
        let key = match oid.as_str() {
            "2.5.4.3" => "CN",
            "2.5.4.6" => "C",
            "2.5.4.7" => "L",
            "2.5.4.8" => "ST",
            "2.5.4.10" => "O",
            "2.5.4.11" => "OU",
            "2.5.4.5" => "serialNumber",
            "2.5.4.4" => "SN",
            "2.5.4.42" => "GN",
            "0.9.2342.19200300.100.1.25" => "DC",
            "0.9.2342.19200300.100.1.1" => "UID",
            "1.2.840.113549.1.9.1" => "emailAddress",
            _ => &oid,
        };
        let value = if let Ok(value) = attribute.as_str() {
            string(value)
        } else if attribute.attr_value().tag() == x509_parser::asn1_rs::Tag::BmpString {
            let bytes = attribute.as_slice();
            if bytes.len() % 2 != 0 {
                return Err("invalid BMPString in TLS certificate name".into());
            }
            let units = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_be_bytes(*b))
                .collect::<Vec<_>>();
            JsString::from_utf16(&units)
        } else {
            return Err(format!(
                "unsupported TLS certificate name encoding for {key}"
            ));
        };
        let key = string(key);
        if let Some((_, values)) = result.iter_mut().find(|(name, _)| *name == key) {
            values.push(value);
        } else {
            result.push((key, vec![value]));
        }
    }
    Ok(result)
}

fn tls_peer_fingerprint(algorithm: &'static ring::digest::Algorithm, bytes: &[u8]) -> JsString {
    use std::fmt::Write as _;
    let digest = ring::digest::digest(algorithm, bytes);
    let mut result = String::with_capacity(digest.as_ref().len() * 3 - 1);
    for (index, byte) in digest.as_ref().iter().enumerate() {
        if index != 0 {
            result.push(':');
        }
        write!(result, "{byte:02X}").expect("writing to String cannot fail");
    }
    string(&result)
}

fn tls_peer_time(timestamp: i64) -> Result<JsString, String> {
    let date = chrono::DateTime::from_timestamp(timestamp, 0)
        .ok_or_else(|| "TLS certificate date is outside the native range".to_owned())?;
    Ok(string(&date.format("%b %e %H:%M:%S %Y GMT").to_string()))
}

fn tls_parse_peer_certificate(der: &[u8]) -> Result<TlsPeerCertificate, String> {
    use std::fmt::Write as _;
    let (remaining, cert) = x509_parser::parse_x509_certificate(der)
        .map_err(|error| format!("TLS peer certificate parsing failed: {error}"))?;
    if !remaining.is_empty() {
        return Err("TLS peer certificate has trailing data".into());
    }
    let serial = cert.raw_serial();
    let serial = serial
        .iter()
        .position(|byte| *byte != 0)
        .map_or(&serial[serial.len().saturating_sub(1)..], |index| {
            &serial[index..]
        });
    let mut serial_number = String::new();
    for byte in serial {
        write!(serial_number, "{byte:02X}").expect("writing to String cannot fail");
    }
    let ca = cert
        .basic_constraints()
        .map_err(|error| format!("invalid TLS certificate constraints: {error}"))?
        .is_some_and(|extension| extension.value.ca);
    Ok(TlsPeerCertificate {
        subject: tls_peer_name(cert.subject())?,
        issuer: tls_peer_name(cert.issuer())?,
        valid_from: tls_peer_time(cert.validity().not_before.timestamp())?,
        valid_to: tls_peer_time(cert.validity().not_after.timestamp())?,
        fingerprint: tls_peer_fingerprint(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, der),
        fingerprint256: tls_peer_fingerprint(&ring::digest::SHA256, der),
        fingerprint512: tls_peer_fingerprint(&ring::digest::SHA512, der),
        serial_number: string(&serial_number),
        ca,
        raw: der.to_vec(),
    })
}

/// Outer None means the socket is destroyed; inner None means no peer
/// certificate has been received yet, which Node exposes as an empty object.
pub fn tls_socket_peer_certificate(socket: &JsNetSocket) -> Option<Option<TlsPeerCertificate>> {
    socket.with(|socket| {
        let tls = socket.tls.as_ref()?;
        let Some(certificate) = tls
            .connection
            .peer_certificates()
            .and_then(|chain| chain.first())
        else {
            return Some(None);
        };
        let value = tls_parse_peer_certificate(certificate.as_ref())
            .unwrap_or_else(|error| throw_error_code(format!("scriptc: {error}"), "SC1031"));
        Some(Some(value))
    })
}
