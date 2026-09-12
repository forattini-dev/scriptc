export const USAGE = `scriptc — TypeScript/JavaScript to native and WebAssembly executables (experimental)

Usage:
  scriptc build <file.ts|.js> [options]     compile to an executable or source artifact
  scriptc run <file.ts|.js> [options]       compile and run
  scriptc coverage <file.ts|.js>            how much compiles statically, and why not
  scriptc coverage <file.ts|.js> --dynamic  what a --dynamic build compiles, and what still blocks it
  scriptc coverage <file.ts|.js> --external-types <specifier=file.d.ts>
                                            type-resolve an embedder-provided module for analysis
  scriptc build --lib --profile <p.json>    library mode: compile the profile's entry
                                            module to a linkable static archive
                                            (<name>.lib.a) exporting the
                                            profile-declared C symbols; a profile
                                            with a sidecar section also gets the
                                            contract sidecar JSON beside the archive
  scriptc cache warm [runtime|tls|dynamic…] prebuild expensive native cache families
                                            for the current compiler/SDK/target

Options:
  -o, --out <path>   primary output path (default: .scriptc/<name><suffix>)
      --emit <kind>  primary output: ir, c, llvm, asm, obj, or exe
                     (default: exe). asm/obj use the matching platform helper
      --print <kind> print machine-readable metadata instead of the output path
                     (native-link-info implies --emit=obj and never links)
      --target <t>   runtime target the binary reproduces: node24 (default),
                     node26, or bun. Selects the ambient type surface
                     (@types/node or @types/bun), the export/imports
                     conditions the module graph resolves with (node, or
                     bun+node), and the runtime's identity. Unset infers
                     from the project (packageManager bun@…, .node-version,
                     engines.node) and says so
      --conditions <c[,c…]>
                     extra export/imports conditions, matched after the
                     target's own (repeatable)
      --island-module <glob[,glob…]>
                     program modules that run in the embedded engine (the
                     island tier) instead of compiling statically; static
                     code binds their exports as engine handles. Globs match
                     paths under the entry's package root (repeatable;
                     requires --dynamic). "auto" lets the compiler move any
                     module whose lowering reports a blocker into the
                     island and lower again, to a fixpoint. The coverage
                     report lists the resulting static frontier with each
                     island module's reason. A scriptc.json beside the
                     entry's package.json pins its "tiers.island" modules
                     without a fixpoint
      --island-store <raw|deflate>
                     how island module texts are embedded: raw (plain
                     bytes, no inflate at boot; the V8 engine's default) or
                     deflate (3-4x smaller binaries; the boa engine's
                     default)
      --write-tiers  after an --island-module auto build or coverage run,
                     persist the frontier into that scriptc.json so later
                     builds skip the fixpoint
      --backend <b>  code generator (default: rust). Rust emits memory-safe
                     native code and invokes rustc directly. Unsupported
                     constructs are diagnostics; no backend fallback occurs.
                     c and llvm are explicit compatibility/debugging backends.
                     Cross-compilation and WASI currently require --backend llvm
                     (or --backend c for supported inspection targets).
      --optimization <release|dev>
                     native optimization posture (default: release/-O2). dev
                     uses -O0 and stable cached LLVM object shards for faster
                     edits of large programs
      --from-c       treat input as a C (or .ll) file (toolchain plumbing/debugging)
      --keep-c       keep the generated program TU next to the executable
                     (default; the .ll, .c, or .rs source selected by backend)
      --no-keep-c    delete the generated program TU after compiling
      --emit-ir      also write IR beside an executable or library archive;
                     deprecated for executables: use --emit=ir for primary IR
      --sanitize     build with ASan + runtime RC audit
      --dynamic      explicitly embed a JS engine (static stays the default)
      --no-engine    reject JavaScript engines and deferred unsupported operations;
                     with --backend rust, checked native dynamic values remain valid
      --ffi <file>   bind signature-only TypeScript declarations to native
                     C symbols and link the manifest's archives/libraries
      --npm-static <pkg[,pkg…]|auto>
                     compile the named npm packages' shipped JS statically as
                     program modules (repeatable; "auto" opts in every eligible
                     direct import: own .d.ts, unminified JS, no build-transform
                     markers). A package preflight refuses falls back to the
                     island (--dynamic) with a coverage-report note — opt-in,
                     experimental
      --provenance-sources
                     EXPERIMENTAL: compile npm dependencies from their
                     provenance-attested SOURCE (fetched at the attested
                     commit) as static program modules; packages without a
                     usable attestation keep the island path (a note, never
                     a failure)
      --external-types <specifier=file.d.ts>
                     coverage only: map an exact bare module specifier to a
                     local declaration file. The declaration supplies types
                     for analysis; the host module remains an explicit
                     external-boundary blocker (repeatable)
  -h, --help         show this help
  -v, --version      print the version
`;

export const CLI_OPTIONS = {
  out: { type: "string", short: "o" },
  emit: { type: "string" },
  print: { type: "string" },
  backend: { type: "string" },
  target: { type: "string" },
  conditions: { type: "string", multiple: true },
  "island-module": { type: "string", multiple: true },
  "island-store": { type: "string" },
  "write-tiers": { type: "boolean", default: false },
  optimization: { type: "string" },
  "from-c": { type: "boolean", default: false },
  "keep-c": { type: "boolean", default: true },
  "emit-ir": { type: "boolean", default: false },
  sanitize: { type: "boolean", default: false },
  dynamic: { type: "boolean", default: false },
  engine: { type: "boolean", default: true },
  ffi: { type: "string" },
  "npm-static": { type: "string", multiple: true },
  "provenance-sources": { type: "boolean", default: false },
  "external-types": { type: "string", multiple: true },
  lib: { type: "boolean", default: false },
  profile: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;
