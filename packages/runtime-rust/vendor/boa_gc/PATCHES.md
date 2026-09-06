# boa_gc 0.22.0, vendored with one change

The registry crate plus a collection policy for long-lived heaps.

## Collection threshold (src/lib.rs, `GcConfig::default`)

boa_gc runs a full mark-sweep whenever allocated bytes cross a threshold
that starts at 1 MB and, after a collection that leaves the heap above
70% of it, grows to `live / 70%` (about 1.43×). A compiled CLI keeps its
whole module graph alive in this heap (hundreds of MB), so the profile of
every redcode command showed about a fifth of its samples inside
`Collector::collect`/`mark_heap`. The patched defaults start at 256 MB and
grow to four times the surviving heap (a CLI run is short-lived; the
boot of a 66 MB module graph now takes one or two collections).
