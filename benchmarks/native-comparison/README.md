# Native comparison benchmark

This benchmark compares the same deterministic JavaScript and TypeScript programs in five execution modes: Node.js from source, Bun from source, a Node.js single executable application (SEA), a Bun standalone executable, and a native scriptc/Rust executable. The scriptc lane always uses the Rust frontend and backend without an embedded JavaScript engine or fallback.

The programs cover numeric loops, typed arrays of records with strings, and `Map`/`Set` collections. Their output is intentionally small and deterministic so the harness can require exact stdout, stderr, and exit-code parity before reporting performance.

Measurements are serialized. Build measurements include elapsed time, total CPU time observed across the process tree, and peak aggregate private memory. Runtime measurements report the median of repeated fresh processes after warmup. Executable size is measured from the generated file. Node SEA is a packaged Node/V8 runtime and Bun's executable includes the Bun runtime; scriptc emits a native Rust program, so file size and startup costs describe materially different deployment models.

Run from the repository root on Windows PowerShell:

```powershell
pwsh -File benchmarks/native-comparison/benchmark.ps1
```

Generated executables, intermediate files, and raw measurements are written below the selected output directory. By default this is a new directory below the system temporary directory, not the checkout. Pass `-OutputDirectory <path>` to retain a stable location and `-RuntimeRuns <n>` to change the number of measured runs.

The default scriptc lane measures the fast development build, whose generated Cargo project uses `opt-level=0`. Pass `-ScriptcOptLevel 3` to benchmark the official `scriptc build --release` path. Release builds use Cargo's separate release artifact cache and do not use a JavaScript engine or fallback.
