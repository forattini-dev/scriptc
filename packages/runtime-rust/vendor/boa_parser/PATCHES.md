# boa_parser 0.22.0, vendored with one change

The registry crate plus an ASCII fast path in the lexer.

## Identifier character tests (src/lexer/identifier.rs)

`is_identifier_start`/`is_identifier_part` asked ICU's `ID_Start`/
`ID_Continue` code point sets for every character of every identifier
(`CodePointInversionList::contains32` showed in boot profiles of a
66 MB module graph). ASCII letters, digits, `$` and `_` now answer
from range tests; everything else still takes the ICU sets, so the
accepted language is unchanged.
