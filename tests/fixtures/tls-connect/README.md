# TLS client test certificate

`repeated.pem` is a self-signed, non-CA test certificate with repeated `CN` and `O` attributes. It uses the existing throwaway `tests/fixtures/server/certs/localhost-key.pem` key and is only used on loopback with certificate verification explicitly disabled. It was generated with `openssl req -new -x509 -key ../server/certs/localhost-key.pem -out repeated.pem -days 36500 -subj '/CN=first/CN=second/O=One/O=Two' -addext 'subjectAltName=DNS:localhost' -addext 'basicConstraints=CA:FALSE'`. Do not use this key or certificate outside tests.
