# Bundled TLS roots

`tls-root-certificates.pem` contains the 145 public Mozilla CA certificates from Node v24.15.0, commit `848430679556aed0bd073f2bc263331ad84fa119`, matching the repository's primary Node target. Source: https://github.com/nodejs/node/blob/848430679556aed0bd073f2bc263331ad84fa119/src/node_root_certs.h. The PEM file SHA-256 is `f7fad114a8d4341eec9c69e34b95e86a69f1bff174e83a4fe6909d630253fd3c`.

The public certificate data retains each issuer's names and identifiers. Node's distribution notices are at https://github.com/nodejs/node/blob/848430679556aed0bd073f2bc263331ad84fa119/LICENSE. This file contains public certificates only, with no private keys.

Extract and concatenate the quoted C strings from that pinned header in their original order. Verify each PEM block byte for byte against `tls.rootCertificates` in the pinned Node executable. Update the snapshot and differential evidence together when the primary Node pin changes. Enumeration and default Rust TLS handshakes use this same bundle, independently of the host filesystem. System CA enumeration remains a separate platform support boundary.
