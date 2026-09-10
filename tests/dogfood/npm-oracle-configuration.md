# Explicit oracle configuration for npm API contracts

The 2026-09-10 current-source residual run passed Rust's datagram and stream
argument tests. Four npm cases failed only at the stderr comparison:

- `island-web-plumbing`: Node's DEP0097 domain/MakeCallback notice.
- `misc-shims`: Node's DEP0040 punycode notice.
- `util-shims`: Node's DEP0044 util.isArray notice.
- `workspace-copied`: an unspecified module type in its own package scope.

The copied workspace root now declares `type: module`; the copied member
and its source member keep their independent CommonJS package scopes.

The other three fixtures explicitly opt into the corpus's existing
`@no-deprecation` configuration. The shared npm helper supplies only
`--no-deprecation` to the Node oracle, including the Linux container lane.
No captured stderr is filtered and no blanket `--no-warnings` is added.
A subprocess test exercises actual Node warnings to check that ordinary
warnings and explicit stderr remain visible, and that an unsupported
`@no-warnings` directive does not suppress either warning category.

This is a fixture/oracle configuration change, not a compiler optimization
or an implementation of Node's built-in deprecation warning behavior.
These fixtures certify API values/errors against the configured Node.
Warning-event/rendering parity remains a separate compatibility limitation.
No external consumer sources were edited.

Original failure and Node controls:
`/tmp/scriptc-schema-cast-20260910/residual-frontier.log`,
`residual-node.json`, and `deprecation-configuration-control.json`.
Final focused validation is being collected under
`/tmp/scriptc-npm-oracle-config-20260910/`.
Full plain/sanitized gates and fresh Redwall/Bun measurements remain pending.
