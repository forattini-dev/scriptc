# Local changes to url 2.5.0

Source: the published `url` 2.5.0 crate (`https://crates.io/crates/url/2.5.0`, registry checksum `31e6302e3bb753d46e83516cae55ae196fc0c309407cf11ab35cc51a4c2a4633`). MIT and Apache-2.0 license files are preserved. All upstream source and tests are included.

`src/parser.rs`: return the file-host parser's path-start decision instead of its host-presence flag, so an empty or localhost host consumes the path delimiter exactly once. In the path-start state, always add the path root slash separately from the authority delimiter (including `file://` with an empty input). Remove the final file-path normalization that discards empty leading segments. Node 24.15.0 preserves these segments: `new URL("../x", "file:////server/a/b").href` is `file:////server/x`. Removing the segments before resolving a relative reference changes the path and cannot be repaired reliably by changing output formatting. The rest of the parser and the dependency graph remain unchanged.

Compiler differential coverage: `tests/corpus/3172-url-base-resolution.ts`, plus existing URL parsing, pathname mutation and file bridge corpus programs. Runtime coverage lives in `src/tests/web_and_platform.rs`. The compiler runtime now uses the parsed path directly instead of keeping a separate extra-slash counter.
