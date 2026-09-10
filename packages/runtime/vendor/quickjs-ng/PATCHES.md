# Local patches to QuickJS-ng

Base: `3c8f3d68953955950074c41c6e4d999562ae82a7` (MIT).

## Missing import and reexport diagnostics

`quickjs.c` constructs missing-export `SyntaxError` messages from the importing
module's original request atom and the requested binding's atom. Indirect
exports name the missing original binding, not its outward alias. A dynamically
growing UTF-16 buffer preserves names beyond the engine's 64-byte atom display
and 256-byte general error formatter limits. The error keeps the normal
SyntaxError prototype, message property attributes and backtrace policy.

The resolution result, linking order, and circular/ambiguous/error branches are
unchanged. This patch affects the C/LLVM embedded engine; the Rust backend uses
its own engine integration.

Validation: `tests/corpus/3158-island-link-diagnostics` compares named/default
imports and reexports with Node using long specifiers and Unicode binding names,
pins the absence of target evaluation on link failure, and then imports a valid
undefined binding. The npm `cjs-lexer-invisible` fixture pins uncaught formatting.
