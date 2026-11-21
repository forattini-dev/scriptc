# Native API inventory

The Rust-native compiler exposes its implementation-owned API manifest through `scriptc builtins`. To cross-reference it with the pinned Node.js documentation census and the existing redDB target snapshot, build the native compiler and run:

```sh
python packages/compiler-rust/tools/native-api-inventory.py --out /path/to/new-report.json
```

The report matches Node documentation symbols to native entries by exact name. Each match contains its declared contract, Rust operation or helper, and test evidence. An unmatched documentation row requires review: aliases, overloads, class members, and APIs implemented through language intrinsics can prevent a name match. The report is an inventory, not a percentage of implemented APIs or a claim that a matching entry implements every overload.

The redDB counts are from the recorded target snapshot, not a live build or a current failure count. The report includes the snapshot's source tree hash and warning so it cannot be mistaken for evidence about the current compiler. Refresh the target inspection and actual builds when evaluating progress.

The pinned Node documentation census is not a complete inventory of ECMAScript built-in classes and prototypes. The Bun section describes only previously evaluated reuse candidates; it is not a complete Bun API census. A complete de-para still needs authoritative, versioned ECMAScript and Bun inventories, mappings for globals and prototype methods, and per-overload semantic tests. Runtime functions without a tested frontend and IR contract remain reuse candidates rather than supported features.

The Rust compiler must implement control-flow semantics as well as library APIs. In particular, `await` suspension and module initialization ordering cannot be supplied by a table that renames functions. Application builds and differential tests remain necessary even when every referenced API has a mapping.
