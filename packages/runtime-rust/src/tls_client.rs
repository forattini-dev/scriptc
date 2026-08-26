use std::io::{Read as _, Write as _};

#[derive(Clone, Copy, Debug, Default)]
enum TlsPeerShape {
    #[default]
    Unknown,
    LeafOnly,
    SelfSigned,
    SelfSignedInChain,
}

#[derive(Debug, Default)]
struct TlsVerifyState {
    peer_shape: TlsPeerShape,
    checked: bool,
    authorization_error: Option<String>,
}

#[derive(Debug)]
struct ScriptcServerVerifier {
    inner: Option<Arc<dyn rustls::client::danger::ServerCertVerifier>>,
    algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
    state: Arc<Mutex<TlsVerifyState>>,
    reject_unauthorized: bool,
}

impl rustls::client::danger::ServerCertVerifier for ScriptcServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let shape = if tls_cert_is_self_signed(end_entity.as_ref()) {
            TlsPeerShape::SelfSigned
        } else if intermediates
            .iter()
            .any(|certificate| tls_cert_is_self_signed(certificate.as_ref()))
        {
            TlsPeerShape::SelfSignedInChain
        } else {
            TlsPeerShape::LeafOnly
        };
        let verdict = match &self.inner {
            Some(inner) => {
                inner.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
            }
            None => Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::UnknownIssuer,
            )),
        };
        {
            let mut state = self
                .state
                .lock()
                .expect("scriptc: TLS verify-state lock poisoned");
            state.peer_shape = shape;
            state.checked = true;
            state.authorization_error = verdict
                .as_ref()
                .err()
                .map(|error| tls_authorization_code(error, shape));
        }
        if self.reject_unauthorized {
            verdict
        } else {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, certificate, signature, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, certificate, signature, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

struct HttpTlsJob {
    request: JsHttpClientRequest,
    connection: Rc<RefCell<HttpClientConnection>>,
    receiver: std::sync::mpsc::Receiver<Result<Vec<u8>, String>>,
}

thread_local! {
    static HTTP_TLS_JOBS: RefCell<Vec<HttpTlsJob>> = const { RefCell::new(Vec::new()) };
}

fn tls_der_item(bytes: &[u8], offset: usize) -> Option<(u8, usize, usize)> {
    let tag = *bytes.get(offset)?;
    let first = *bytes.get(offset + 1)?;
    let (header_len, content_len) = if first & 0x80 == 0 {
        (2, usize::from(first))
    } else {
        let length_bytes = usize::from(first & 0x7f);
        if length_bytes == 0 || length_bytes > std::mem::size_of::<usize>() {
            return None;
        }
        let mut length = 0_usize;
        for byte in bytes.get(offset + 2..offset + 2 + length_bytes)? {
            length = length.checked_mul(256)?.checked_add(usize::from(*byte))?;
        }
        (2 + length_bytes, length)
    };
    let content = offset.checked_add(header_len)?;
    let end = content.checked_add(content_len)?;
    (end <= bytes.len()).then_some((tag, content, end))
}

fn tls_cert_names(certificate: &[u8]) -> Option<(&[u8], &[u8])> {
    let (outer_tag, outer_content, outer_end) = tls_der_item(certificate, 0)?;
    if outer_tag != 0x30 || outer_end != certificate.len() {
        return None;
    }
    let (tbs_tag, tbs_content, _) = tls_der_item(certificate, outer_content)?;
    if tbs_tag != 0x30 {
        return None;
    }
    let mut offset = tbs_content;
    if tls_der_item(certificate, offset)?.0 == 0xa0 {
        offset = tls_der_item(certificate, offset)?.2;
    }
    for _ in 0..2 {
        offset = tls_der_item(certificate, offset)?.2;
    }
    let issuer_start = offset;
    let (issuer_tag, _, issuer_end) = tls_der_item(certificate, issuer_start)?;
    if issuer_tag != 0x30 {
        return None;
    }
    offset = issuer_end;
    offset = tls_der_item(certificate, offset)?.2;
    let subject_start = offset;
    let (subject_tag, _, subject_end) = tls_der_item(certificate, subject_start)?;
    if subject_tag != 0x30 {
        return None;
    }
    Some((
        &certificate[issuer_start..issuer_end],
        &certificate[subject_start..subject_end],
    ))
}

fn tls_cert_is_self_signed(certificate: &[u8]) -> bool {
    tls_cert_names(certificate).is_some_and(|(issuer, subject)| issuer == subject)
}

fn tls_roots(trust: &TlsTrust) -> Result<rustls::RootCertStore, String> {
    let mut roots = rustls::RootCertStore::empty();
    if trust.use_bundled {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    for pem in &trust.pem_certificates {
        let mut cursor = std::io::Cursor::new(pem.as_bytes());
        let certificates = rustls_pemfile::certs(&mut cursor)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "PEM routines: no start line".to_string())?;
        if certificates.is_empty() {
            return Err("PEM routines: no start line".to_string());
        }
        for certificate in certificates {
            roots
                .add(certificate)
                .map_err(|_| "PEM routines: bad certificate".to_string())?;
        }
    }
    Ok(roots)
}

fn tls_config(
    trust: &TlsTrust,
    reject_unauthorized: bool,
    state: Arc<Mutex<TlsVerifyState>>,
) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = Arc::new(tls_roots(trust)?);
    let inner = if !roots.is_empty() {
        Some(
            rustls::client::WebPkiServerVerifier::builder_with_provider(roots, provider.clone())
                .build()
                .map_err(|error| error.to_string())?
                as Arc<dyn rustls::client::danger::ServerCertVerifier>,
        )
    } else {
        None
    };
    let verifier = Arc::new(ScriptcServerVerifier {
        inner,
        algorithms: provider.signature_verification_algorithms,
        state,
        reject_unauthorized,
    });
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok(config)
}

fn tls_authorization_code(error: &rustls::Error, peer_shape: TlsPeerShape) -> String {
    match error {
        rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer) => {
            match peer_shape {
                TlsPeerShape::SelfSigned => "DEPTH_ZERO_SELF_SIGNED_CERT",
                TlsPeerShape::SelfSignedInChain => "SELF_SIGNED_CERT_IN_CHAIN",
                _ => "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            }
        }
        rustls::Error::InvalidCertificate(rustls::CertificateError::Expired) => {
            "CERT_HAS_EXPIRED"
        }
        rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidYet) => {
            "CERT_NOT_YET_VALID"
        }
        rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidForName) => {
            "ERR_TLS_CERT_ALTNAME_INVALID"
        }
        _ => "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    }
    .to_string()
}

fn tls_error_message(error: &std::io::Error, peer_shape: TlsPeerShape) -> String {
    let Some(rustls_error) = error
        .get_ref()
        .and_then(|source| source.downcast_ref::<rustls::Error>())
    else {
        return error.to_string();
    };
    match rustls_error {
        rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer) => {
            match peer_shape {
                TlsPeerShape::SelfSigned => concat!(
                    "self-signed certificate; if the root CA is installed locally, ",
                    "try running Node.js with --use-system-ca",
                )
                .to_string(),
                TlsPeerShape::SelfSignedInChain => {
                    "self-signed certificate in certificate chain".to_string()
                }
                _ => concat!(
                    "unable to verify the first certificate; if the root CA is installed locally, ",
                    "try running Node.js with --use-system-ca",
                )
                .to_string(),
            }
        }
        rustls::Error::InvalidCertificate(rustls::CertificateError::Expired) => {
            "certificate has expired".to_string()
        }
        rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidYet) => {
            "certificate is not yet valid".to_string()
        }
        _ => rustls_error.to_string(),
    }
}

fn tls_chunked_end(bytes: &[u8], mut offset: usize) -> Option<usize> {
    loop {
        let line_end = bytes[offset..]
            .windows(2)
            .position(|window| window == b"\r\n")?
            + offset;
        let line = std::str::from_utf8(&bytes[offset..line_end]).ok()?;
        let size = usize::from_str_radix(line.split(';').next()?.trim(), 16).ok()?;
        offset = line_end + 2;
        if size == 0 {
            if bytes.get(offset..offset + 2) == Some(b"\r\n") {
                return Some(offset + 2);
            }
            let trailers = bytes[offset..]
                .windows(4)
                .position(|window| window == b"\r\n\r\n")?;
            return Some(offset + trailers + 4);
        }
        let chunk_end = offset.checked_add(size)?;
        if bytes.get(chunk_end..chunk_end + 2) != Some(b"\r\n") {
            return None;
        }
        offset = chunk_end + 2;
    }
}

fn tls_http_response_end(bytes: &[u8], method: &str) -> Option<usize> {
    let head_len = http_header_end(bytes)?;
    let head = std::str::from_utf8(&bytes[..head_len]).ok()?;
    let mut lines = head[..head.len().saturating_sub(4)].split("\r\n");
    let status = lines
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse::<u16>()
        .ok()?;
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.trim().parse::<usize>().ok();
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("chunked"));
        }
    }
    if method.eq_ignore_ascii_case("HEAD")
        || (100..200).contains(&status)
        || status == 204
        || status == 304
    {
        return Some(head_len);
    }
    if chunked {
        return tls_chunked_end(bytes, head_len);
    }
    content_length
        .and_then(|length| head_len.checked_add(length))
        .filter(|end| bytes.len() >= *end)
}

fn tls_exchange(
    host: String,
    port: u16,
    method: String,
    trust: TlsTrust,
    reject_unauthorized: bool,
    timeout: f64,
    request: Vec<u8>,
) -> Result<Vec<u8>, String> {
    let verify_state = Arc::new(Mutex::new(TlsVerifyState::default()));
    let config = tls_config(&trust, reject_unauthorized, verify_state.clone())?;
    let server_name = rustls::pki_types::ServerName::try_from(host.clone())
        .map_err(|_| format!("Invalid SNI name: {host}"))?;
    let mut socket = std::net::TcpStream::connect((host.as_str(), port))
        .map_err(|error| format!("connect {} {host}:{port}", fs_error_code(&error)))?;
    let timeout_ms = if timeout.is_finite() && timeout > 0.0 {
        timeout.min(60_000.0).trunc() as u64
    } else {
        60_000
    };
    let io_timeout = Some(std::time::Duration::from_millis(timeout_ms));
    socket
        .set_read_timeout(io_timeout)
        .map_err(|error| error.to_string())?;
    socket
        .set_write_timeout(io_timeout)
        .map_err(|error| error.to_string())?;
    let mut connection = rustls::ClientConnection::new(Arc::new(config), server_name)
        .map_err(|error| error.to_string())?;
    while connection.is_handshaking() {
        if let Err(error) = connection.complete_io(&mut socket) {
            let shape = verify_state
                .lock()
                .expect("scriptc: TLS verify-state lock poisoned")
                .peer_shape;
            return Err(tls_error_message(&error, shape));
        }
    }
    let mut stream = rustls::StreamOwned::new(connection, socket);
    stream
        .write_all(&request)
        .map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        if let Some(end) = tls_http_response_end(&response, &method) {
            response.truncate(end);
            return Ok(response);
        }
        match stream.read(&mut chunk) {
            Ok(0) if response.is_empty() => {
                return Err("socket hang up".to_string());
            }
            Ok(0) => return Ok(response),
            Ok(length) => response.extend_from_slice(&chunk[..length]),
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn http_tls_start(
    request: &JsHttpClientRequest,
    connection: Rc<RefCell<HttpClientConnection>>,
    output: Vec<u8>,
) {
    let (host, port, method, trust, reject_unauthorized, timeout) = request.with(|request| {
        (
            request.host.to_string(),
            request.port,
            request.method.to_string(),
            tls_explicit_trust(request.ca.to_string()),
            request.reject_unauthorized,
            request.timeout,
        )
    });
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = tls_exchange(
            host,
            port,
            method,
            trust,
            reject_unauthorized,
            timeout,
            output,
        );
        let _ = sender.send(result);
    });
    HTTP_TLS_JOBS.with(|jobs| {
        jobs.borrow_mut().push(HttpTlsJob {
            request: request.clone(),
            connection,
            receiver,
        });
    });
}

fn http_tls_dispatch_one() -> bool {
    let completed = HTTP_TLS_JOBS.with(|jobs| {
        let mut jobs = jobs.borrow_mut();
        let ready =
            jobs.iter()
                .enumerate()
                .find_map(|(index, job)| match job.receiver.try_recv() {
                    Ok(result) => Some((index, result)),
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        Some((index, Err("TLS worker stopped".to_string())))
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => None,
                });
        ready.map(|(index, result)| (jobs.swap_remove(index), result))
    });
    let Some((job, result)) = completed else {
        return false;
    };
    if job.request.with(|request| request.destroyed) {
        return true;
    }
    match result {
        Ok(response) => {
            http_client_feed(&job.connection, &job.request, &response);
            http_client_eof(&job.connection);
            http_client_dispatch_close(&job.request);
        }
        Err(message) => {
            http_client_dispatch_error(&job.request, error_new("Error", string(&message)));
            http_client_dispatch_close(&job.request);
        }
    }
    true
}

fn http_tls_cancel(request: &JsHttpClientRequest) {
    HTTP_TLS_JOBS.with(|jobs| {
        jobs.borrow_mut().retain(|job| !job.request.ptr_eq(request));
    });
}

fn http_tls_pending() -> bool {
    HTTP_TLS_JOBS.with(|jobs| !jobs.borrow().is_empty())
}

fn http_tls_finish() {
    HTTP_TLS_JOBS.with(|jobs| jobs.borrow_mut().clear());
}

#[cfg(test)]
mod tls_client_tests {
    use super::*;

    #[test]
    fn detects_complete_fixed_chunked_and_head_responses() {
        let fixed = b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ntest";
        assert_eq!(tls_http_response_end(fixed, "GET"), Some(fixed.len()));
        let chunked =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ntest\r\n0\r\n\r\n";
        assert_eq!(tls_http_response_end(chunked, "GET"), Some(chunked.len()));
        let head = b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n";
        assert_eq!(tls_http_response_end(head, "HEAD"), Some(head.len()));
    }
}
