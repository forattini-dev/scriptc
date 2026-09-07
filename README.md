# scriptc

scriptc compiles TypeScript and JavaScript to native executables through Rust. Rust is the primary and default backend: the TypeScript frontend builds a typed IR, the Rust backend emits memory-safe code, and `rustc` produces the executable. C and direct LLVM emission remain explicitly selectable compatibility and comparison backends.

Static builds include a small native runtime, but no Node or JavaScript engine. Code that cannot compile statically is reported as a diagnostic. For code that requires a JavaScript engine, `--dynamic` opts in explicitly. Rust uses V8 by default (Boa is optional); C/LLVM use quickjs-ng. The native mission uses `--no-engine` and statically admitted npm sources.

scriptc is experimental and targets macOS, Linux, Windows, and WebAssembly via WASI Preview 1.

## Installation

The compiler requires Node.js 24 or newer, Cargo, and rustc. Explicit C/LLVM builds require clang. The executables it produces do not require Node.

```console
$ npm install -g scriptc
```

## Build a program

Create `hello.ts`:

```ts
const who = process.argv.length > 2 ? process.argv[2] : "world";
console.log(`hello, ${who}`);
```

Compile and run it in one step:

```console
$ scriptc run hello.ts
hello, world
```

Or write a standalone executable:

```console
$ scriptc build hello.ts -o hello
$ ./hello ctate
hello, ctate
```

Rust is also selectable explicitly:

```console
$ scriptc build hello.ts --backend rust -o hello-rust
$ ./hello-rust ctate
hello, ctate
```

For native builds without an embedded JavaScript engine, use
`scriptc build hello.ts --backend rust --no-engine`. This rejects engine
imports, evaluation, persisted island modules, and deferred unsupported
operations before building. Checked native dynamic values remain available.
`scriptc coverage hello.ts --no-engine` also checks Rust
emission and exits nonzero on a refusal; successful coverage does not replace
compiling and testing the executable. Engine absence does not imply that all
transitive native dependencies forbid unsafe code.

Rust builds emit `#![forbid(unsafe_code)]`, do not translate through C, and
report unsupported constructs instead of falling back to another backend. The
current subset includes classes with constructors, fields, accessors,
monomorphic and virtual methods, generic specializations, abstract dispatch,
first-class constructor values, lexical `this` captures, object identity,
single inheritance, runtime `instanceof`, composition, collectable cycles,
array identity searches and higher-order callbacks, and insertion-ordered
`Map` and `Set` containers with live iteration. Compact type-directed
`JSON.stringify` covers scalars, nested
arrays, records, unions, optional fields, and circular-value errors. Typed
`JSON.parse(...) as T` boundaries validate and build the same JSON-safe types.
Common string searches, slicing, trimming, repetition, case conversion, and
UTF-16 indexed access are also available. Basic synchronous filesystem,
process, POSIX path, typed-array, and `Buffer` workflows are supported too.

## Use Node APIs

Supported Node APIs compile to the native runtime. For example, `server.ts`:

```ts
import { createServer } from "node:http";

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ path: req.url }));
});

server.listen(8080, () => {
  console.log("listening on http://localhost:8080");
});
```

```console
$ scriptc build server.ts -o server
$ ./server
listening on http://localhost:8080
```

## Check static coverage

`scriptc coverage` shows how much of a program can compile statically and gives a coded diagnostic for every dynamic or unsupported site.

```console
$ scriptc coverage hello.ts

  statements analyzed   2
  compile statically    2  (100%)

  fully static — this program has no dynamic remainder.
```

## Build WebAssembly

Cross-target builds currently require an explicit C/LLVM backend and Zig.
The WASI compatibility path is not validated at this checkpoint: the local
smoke failed compiling C runtime references to `realpath`, `chmod` and
`DT_SOCK`. See the [native gate follow-up](./tests/dogfood/native-gate.md).
Rust currently builds for the native host and reports unsupported targets.

## Use npm packages

Pass `--dynamic` to embed an npm package's JavaScript in the executable. The result does not read `node_modules` at runtime.

```ts
import pc from "picocolors";

console.log(pc.green("hello from scriptc"));
```

```console
$ npm install picocolors
$ scriptc build cli.ts --dynamic -o cli
$ ./cli
hello from scriptc
```

## Documentation

See the [quickstart](https://scriptc.dev/quickstart) and [CLI reference](https://scriptc.dev/cli) for the complete workflow. The docs also describe [npm dependencies](https://scriptc.dev/dependencies), [native FFI](https://scriptc.dev/ffi), [platform support](https://scriptc.dev/platforms), and the current [limitations](https://scriptc.dev/limitations).

## Backend direction

New native functionality prioritizes Rust. Shared frontend/IR changes retain
regression coverage for the explicit C/LLVM lanes; a new Rust capability need
not wait for equivalent implementations there. Unsupported operations never
select another backend implicitly. The compiler remains experimental.

[The Rust roadmap](./RUST_ROADMAP.md) defines the quality and consumer-acceptance
criteria. Superiority over direct LLVM emission is a target to demonstrate,
not a claim established by the default selection.

## Development

```console
$ pnpm install && pnpm -r build
$ pnpm test:sandbox
```

The test corpus runs each program under Node and as a compiled native binary, then compares stdout, stderr, and exit codes byte for byte. The full gate also runs the corpus with AddressSanitizer and the runtime reference-count audit.
