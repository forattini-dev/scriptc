# Runtime integration-test certificates

Byte-for-byte copies of `tests/fixtures/server/certs/`, kept here so the
`runtime-rust` crate can `include_str!` them without reaching outside its own
package. The canonical fixtures — and the openssl recipe that minted them,
together with `san.cnf` — live in `tests/fixtures/server/certs/README.md`; mint
there and re-copy, never regenerate in place.

All of them carry ~100-year (36500-day) validity so the suite never depends on a
system trust store, a clock skew, or a re-minting step.

| file | role |
| --- | --- |
| `ca.pem` | trust anchor that signs `localhost.pem` |
| `ca2.pem` | deliberately wrong anchor for negative verification cases |
| `localhost.pem` / `localhost-key.pem` | leaf, SAN `DNS:localhost, IP:127.0.0.1, IP:::1` |
| `selfsigned.pem` / `selfsigned-key.pem` | self-signed `CN=localhost` leaf for depth-zero error shapes |

The keys are throwaway P-256 test material. Nothing here is a secret.
