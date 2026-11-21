#![forbid(unsafe_code)]

mod builtins;
mod emit;
mod frontend;
mod ir;
mod project;
mod string_builtins;
mod survey;

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

fn main() -> ExitCode {
    let worker = std::thread::Builder::new()
        .name("scriptc-frontend".into())
        .stack_size(32 * 1024 * 1024)
        .spawn(run)
        .expect("scriptc: cannot start frontend worker");
    worker
        .join()
        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

fn run() -> ExitCode {
    match execute() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn execute() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1);
    let command = args
        .next()
        .ok_or("usage: scriptc build|inspect|diagnose <file.ts|file.js> [--project <tsconfig>] --out <path>; scriptc build <file> [--release] --out <binary>; scriptc build <file> --emit chunks|chunk-abi [--chunk-bytes N] --out <plan.json>; scriptc survey <manifest.json> --out <report.json>; scriptc builtins")?;
    if command == "survey" {
        return survey::run(args);
    }
    if command == "builtins" {
        if args.next().is_some() {
            return Err("SCN0001: builtins takes no arguments".into());
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&builtins::manifest()).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    if command == "--version" {
        println!(
            "scriptc native 0.1.1-rust.0; frontend {}; IR {}; engine none",
            frontend::REVISION,
            ir::VERSION
        );
        return Ok(());
    }
    if command != "build" && command != "inspect" && command != "diagnose" {
        return Err("SCN0001: expected build, inspect, diagnose, survey or builtins".into());
    }
    let input = fs::canonicalize(PathBuf::from(
        args.next().ok_or("SCN0001: missing input file")?,
    ))
    .map_err(|e| format!("SCN0001: input: {e}"))?;
    if !matches!(
        input.extension().and_then(|e| e.to_str()),
        Some("ts" | "js" | "mts" | "mjs" | "cjs")
    ) {
        return Err("SCN0001: expected a TypeScript/JavaScript file".into());
    }
    let mut kind = String::from("bin");
    let mut out = None;
    let mut project_path = None;
    let mut max_units = 100usize;
    let mut start_unit = 0usize;
    let mut linked = false;
    let mut release = false;
    let mut allow_semantic_errors = false;
    let mut chunk_bytes = 4 * 1024 * 1024usize;
    while let Some(arg) = args.next() {
        if arg == "--emit" {
            if command != "build" {
                return Err("SCN0001: --emit is only for build".into());
            }
            kind = args
                .next()
                .ok_or("SCN0001: missing --emit value")?
                .into_string()
                .map_err(|_| "SCN0001: invalid --emit")?;
        } else if arg == "--project" {
            project_path = Some(PathBuf::from(
                args.next().ok_or("SCN0001: missing --project value")?,
            ));
        } else if arg == "--out" {
            out = Some(PathBuf::from(
                args.next().ok_or("SCN0001: missing --out value")?,
            ));
        } else if arg == "--chunk-bytes" && command == "build" {
            chunk_bytes = args
                .next()
                .and_then(|arg| arg.to_str().and_then(|value| value.parse().ok()))
                .filter(|value| *value > 0)
                .ok_or("SCN0001: --chunk-bytes expects a positive integer")?;
        } else if arg == "--release" && command == "build" {
            release = true;
        } else if arg == "--allow-semantic-errors" && command == "build" {
            allow_semantic_errors = true;
        } else if arg == "--planning-only" && command == "diagnose" {
            max_units = 0;
        } else if arg == "--max-units" && command == "diagnose" {
            max_units = args
                .next()
                .and_then(|arg| arg.to_str().and_then(|s| s.parse().ok()))
                .filter(|n| *n <= 10000)
                .ok_or("SCN0001: --max-units expects an integer from 0 to 10000")?;
        } else if arg == "--all" && command == "diagnose" {
            max_units = usize::MAX;
        } else if arg == "--linked" && command == "diagnose" {
            linked = true;
        } else if arg == "--start-unit" && command == "diagnose" {
            start_unit = args
                .next()
                .and_then(|arg| arg.to_str().and_then(|s| s.parse().ok()))
                .ok_or("SCN0001: --start-unit expects a nonnegative integer")?;
        } else if arg != "--no-engine" {
            return Err(format!("SCN0001: unsupported option {arg:?}"));
        }
    }
    if !matches!(
        kind.as_str(),
        "bin" | "ir" | "rust" | "chunks" | "chunk-abi"
    ) {
        return Err("SCN0001: --emit expects bin, ir, rust, chunks or chunk-abi".into());
    }
    if release && kind != "bin" {
        return Err("SCN0001: --release requires binary emission".into());
    }
    let out = out.ok_or("SCN0001: --out is required")?;
    let out = if out.is_absolute() {
        out
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(out)
    };
    if fs::canonicalize(&out).is_ok_and(|path| path == input) {
        return Err("SCN0001: output would overwrite the input".into());
    }
    if command == "build"
        && kind == "bin"
        && (out.with_extension("rs") == out || out.with_extension("ir.json") == out)
    {
        return Err("SCN0001: binary output collides with an IR/Rust sidecar".into());
    }
    if cfg!(windows)
        && command == "build"
        && kind == "bin"
        && !out
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err("SCN0001: Windows binary output must end in .exe".into());
    }
    let parent = out.parent().ok_or("SCN0001: output has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let work = tempfile::Builder::new()
        .prefix("scriptc-native-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let project = project::discover(&input, project_path.as_deref())?;
    if command == "diagnose" {
        if out.extension().and_then(|ext| ext.to_str()) != Some("json") {
            return Err("SCN0001: diagnose output must be a .json report".into());
        }
        if out.exists() {
            let old = fs::read(&out)
                .ok()
                .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok());
            if !old.is_some_and(|value| {
                value["kind"] == "isolated-lowering-diagnostics" && value["schemaVersion"] == 1
            }) {
                return Err("SCN0001: diagnose only replaces an existing diagnostic report".into());
            }
        }
        let report = frontend::diagnose(
            &input,
            work.path(),
            project.as_deref(),
            max_units,
            linked,
            start_unit,
        )?;
        atomic_write(
            &out,
            &serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
        )?;
        println!(
            "{}",
            serde_json::json!({"diagnostics": out, "compiler": "rust", "engine": "none"})
        );
        return Ok(());
    }
    if command == "inspect" {
        if kind != "bin" {
            return Err(
                "SCN0001: inspect writes a JSON inventory; --emit is only for build".into(),
            );
        }
        let report = frontend::inspect::inspect(&input, work.path(), project.as_deref())?;
        atomic_write(
            &out,
            &serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
        )?;
        println!(
            "{}",
            serde_json::json!({"inspection": out, "engine": "none", "compiler": "rust"})
        );
        return Ok(());
    }
    if kind == "chunks" {
        // Chunking is an architectural diagnostic as well as an emission
        // step. It must remain available when later statement lowering has
        // unsupported surfaces, otherwise large projects regress to the
        // first-error-at-a-time workflow this plan is intended to replace.
        let diagnostics = trace_phase("frontend module planning", || {
            frontend::diagnose(&input, work.path(), project.as_deref(), 0, false, 0)
        })?;
        let plan = trace_phase("chunk planning", || {
            emit::chunks::plan_sources(&diagnostics.source_modules, chunk_bytes)
                .map_err(|e| format!("SCN9001: {e}"))
        })?;
        atomic_write(
            &out,
            &serde_json::to_vec_pretty(&plan).map_err(|e| e.to_string())?,
        )?;
        println!(
            "{}",
            serde_json::json!({
                "compiler": "rust",
                "engine": "none",
                "chunkPlanPath": out,
                "chunks": plan.chunks.len(),
                "targetWeight": plan.target_weight,
                "totalWeight": plan.total_weight
            })
        );
        return Ok(());
    }
    let module = trace_phase("frontend", || {
        frontend::lower(
            &input,
            work.path(),
            project.as_deref(),
            allow_semantic_errors,
        )
    })?;
    if let Some(path) = std::env::var_os("SCRIPTC_TRACE_FRONTEND_IR") {
        let json = serde_json::to_vec_pretty(&module).map_err(|error| error.to_string())?;
        std::fs::write(path, json).map_err(|error| error.to_string())?;
    }
    trace_phase("IR validation", || {
        ir::validate(&module).map_err(|e| format!("SCN9001: {e}"))
    })?;
    if kind == "chunk-abi" {
        let emission = trace_phase("measured Rust emission", || {
            emit::rust_with_metrics(&module).map_err(|e| format!("SCN9001: {e}"))
        })?;
        let total_bytes = emission.source.len();
        let function_body_bytes = emission.function_body_bytes.values().sum();
        let section_bytes = emission.section_bytes.clone();
        let adapter_definitions = emission.adapter_definitions;
        let retained_adapters = emission.retained_adapters;
        let removed_adapter_bytes = emission.removed_adapter_bytes;
        let mut plan = trace_phase("chunk ABI planning", || {
            emit::chunks::plan_abi(&module, chunk_bytes).map_err(|e| format!("SCN9001: {e}"))
        })?;
        plan.measured_rust = Some(emit::chunks::MeasuredRust {
            total_bytes,
            abi_and_root_bytes: emission.abi_and_root_bytes,
            function_body_bytes,
            by_source_module: emission.function_body_bytes,
            by_section: emission.section_bytes,
            value_adapter_definitions: adapter_definitions,
            retained_value_adapters: retained_adapters,
            removed_value_adapter_bytes: removed_adapter_bytes,
            removed_dead_locals: emission.removed_dead_locals,
            removed_dead_local_declarations: emission.removed_dead_local_declarations,
            removed_dead_local_assignments: emission.removed_dead_local_assignments,
            preserved_dead_local_effects: emission.preserved_dead_local_effects,
            callable_functions: emission.callable_functions,
            direct_only_functions: emission.direct_only_functions,
            function_abi_types: emission.function_abi_types,
        });
        atomic_write(
            &out,
            &serde_json::to_vec_pretty(&plan).map_err(|e| e.to_string())?,
        )?;
        println!(
            "{}",
            serde_json::json!({
                "compiler": "rust",
                "engine": "none",
                "chunkAbiPath": out,
                "chunks": plan.chunks.len(),
                "crossChunkReferences": plan.cross_chunk_references.len(),
                "abiOwnedFunctions": plan.abi_owned_functions.len(),
                "abiOwnedClasses": plan.abi_owned_classes.len(),
                "abiOwnedGlobals": plan.abi_owned_globals.len()
                ,"measuredRustBytes": total_bytes
                ,"measuredAbiAndRootBytes": plan.measured_rust.as_ref().unwrap().abi_and_root_bytes
                ,"measuredFunctionBodyBytes": function_body_bytes
                ,"measuredSectionBytes": section_bytes
                ,"valueAdapterDefinitions": adapter_definitions
                ,"retainedValueAdapters": retained_adapters
                ,"removedValueAdapterBytes": removed_adapter_bytes
                ,"removedDeadLocals": emission.removed_dead_locals
                ,"removedDeadLocalDeclarations": emission.removed_dead_local_declarations
                ,"removedDeadLocalAssignments": emission.removed_dead_local_assignments
                ,"preservedDeadLocalEffects": emission.preserved_dead_local_effects
                ,"callableFunctions": emission.callable_functions
                ,"directOnlyFunctions": emission.direct_only_functions
                ,"functionAbiTypes": emission.function_abi_types
            })
        );
        return Ok(());
    }
    let json = trace_phase("IR serialization", || {
        serde_json::to_vec_pretty(&module).map_err(|e| e.to_string())
    })?;
    let rust = if kind == "ir" {
        None
    } else {
        Some(trace_phase("Rust emission", || {
            emit::rust_with_metrics(&module).map_err(|e| format!("SCN9001: {e}"))
        })?)
    };
    let (ir_path, rust_path, binary_path) = match kind.as_str() {
        "ir" => {
            atomic_write(&out, &json)?;
            (Some(out.clone()), None, None)
        }
        "rust" => {
            let rust = rust.as_ref().expect("Rust emission requested");
            atomic_write(&out, rust.source.as_bytes())?;
            (None, Some(out.clone()), None)
        }
        _ => {
            let rust = rust.as_ref().expect("binary emission requires Rust");
            let ir_path = out.with_extension("ir.json");
            let rust_path = out.with_extension("rs");
            let partition = emit::chunks::plan_abi(&module, chunk_bytes)
                .map_err(|error| format!("SCN9001: {error}"))?
                .partition;
            // Compile before publishing any artifacts. A failed build leaves
            // previous successful outputs intact.
            let binary = trace_phase("Cargo", || {
                compile(
                    rust,
                    &partition,
                    work.path(),
                    emit::uses_runtime(&module),
                    release,
                )
            })?;
            let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
            fs::copy(&binary, staged.path()).map_err(|e| e.to_string())?;
            staged.flush().map_err(|e| e.to_string())?;
            fs::set_permissions(
                staged.path(),
                fs::metadata(&binary)
                    .map_err(|e| e.to_string())?
                    .permissions(),
            )
            .map_err(|e| e.to_string())?;
            atomic_write(&ir_path, &json)?;
            atomic_write(&rust_path, rust.source.as_bytes())?;
            staged.persist(&out).map_err(|e| e.to_string())?;
            (Some(ir_path), Some(rust_path), Some(out.clone()))
        }
    };
    println!(
        "{}",
        serde_json::json!({ "compiler": "rust", "backend": "rust", "engine": "none", "externalFfi": false,
        "frontendRevision": frontend::REVISION, "irVersion": ir::VERSION,
        "project": project, "profile": if release { "release" } else { "dev" },
        "irPath": ir_path, "rustPath": rust_path, "binaryPath": binary_path,
        "semanticDiagnosticsAccepted": allow_semantic_errors })
    );
    Ok(())
}

/// Milliseconds since the first trace query in this process.
fn trace_elapsed_ms() -> u128 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis()
}

fn trace_phase<T>(name: &str, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if !std::env::var("SCRIPTC_TRACE_PHASES").is_ok_and(|value| value == "1") {
        return work();
    }
    eprintln!("scriptc: {name} started");
    let start = std::time::Instant::now();
    let result = work();
    eprintln!(
        "scriptc: {name} {} ({} ms)",
        if result.is_ok() { "finished" } else { "failed" },
        start.elapsed().as_millis()
    );
    result
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("output has no parent")?)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn cargo_executable() -> PathBuf {
    for variable in ["SCRIPTC_CARGO", "CARGO"] {
        if let Some(value) = std::env::var_os(variable).filter(|value| !value.is_empty()) {
            return PathBuf::from(value);
        }
    }
    if cfg!(windows) {
        if let Some(path) = std::env::var_os("PATH") {
            for directory in std::env::split_paths(&path) {
                let candidate = directory.join("cargo.exe");
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            let candidate = PathBuf::from(profile).join(".cargo/bin/cargo.exe");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("cargo")
}

struct RustSourceModule {
    name: String,
    source: String,
}

fn split_rust_source(
    source: &str,
    ranges: &[emit::RustFunctionRange],
    partition: &emit::chunks::ChunkPlan,
) -> Result<(String, Vec<RustSourceModule>), String> {
    if ranges.is_empty() {
        return Ok((source.into(), Vec::new()));
    }
    for pair in ranges.windows(2) {
        if pair[0].end != pair[1].start {
            return Err("SCN9001: emitted function ranges are not contiguous".into());
        }
    }
    let mut owner = std::collections::BTreeMap::<&str, &str>::new();
    for chunk in &partition.chunks {
        for module in &chunk.modules {
            owner.insert(module, &chunk.id);
        }
    }
    let mut groups = std::collections::BTreeMap::<String, Vec<&emit::RustFunctionRange>>::new();
    for range in ranges {
        groups
            .entry(
                owner
                    .get(range.source_file.as_str())
                    .copied()
                    .unwrap_or("scriptc_abi")
                    .into(),
            )
            .or_default()
            .push(range);
    }
    let mut declarations = String::new();
    let mut modules = Vec::with_capacity(groups.len());
    for (index, (_, ranges)) in groups.into_iter().enumerate() {
        let name = format!("scriptc_functions_{index:04}");
        declarations.push_str(&format!("mod {name};\npub(crate) use {name}::*;\n"));
        let body_bytes: usize = ranges.iter().map(|range| range.end - range.start).sum();
        let mut module_source = String::with_capacity("use super::*;\n".len() + body_bytes);
        module_source.push_str("use super::*;\n");
        for range in ranges {
            let function = &source[range.start..range.end];
            let function = function
                .strip_prefix("\nfn ")
                .ok_or("SCN9001: emitted function does not start at its Rust item boundary")?;
            module_source.push_str("\npub(crate) fn ");
            module_source.push_str(function);
        }
        modules.push(RustSourceModule {
            name,
            source: module_source,
        });
    }
    let first = ranges.first().unwrap().start;
    let last = ranges.last().unwrap().end;
    let mut root = String::with_capacity(source.len() - (last - first) + declarations.len());
    root.push_str(&source[..first]);
    root.push_str(&declarations);
    root.push_str(&source[last..]);
    Ok((root, modules))
}

fn compile(
    emission: &emit::RustEmission,
    partition: &emit::chunks::ChunkPlan,
    work: &Path,
    uses_runtime: bool,
    release: bool,
) -> Result<PathBuf, String> {
    let source = &emission.source;
    fs::create_dir(work.join("src")).map_err(|e| e.to_string())?;
    let (root_source, modules) =
        if std::env::var("SCRIPTC_NATIVE_RUST_MODULES").is_ok_and(|value| value == "1") {
            split_rust_source(source, &emission.function_ranges, partition)?
        } else {
            (source.clone(), Vec::new())
        };
    fs::write(work.join("src/main.rs"), root_source).map_err(|e| e.to_string())?;
    for module in &modules {
        fs::write(
            work.join("src").join(format!("{}.rs", module.name)),
            &module.source,
        )
        .map_err(|e| e.to_string())?;
    }
    if std::env::var("SCRIPTC_TRACE_PHASES").is_ok_and(|value| value == "1") {
        eprintln!(
            "scriptc: Cargo source uses {} generated function module(s)",
            modules.len()
        );
    }
    // Unique package names let parallel builds share dependency artifacts
    // without racing over the program binary after Cargo releases its lock.
    let package = work
        .file_name()
        .ok_or("missing work directory name")?
        .to_string_lossy()
        .replace('-', "_");
    let compiler_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let runtime_root = compiler_root.join("../runtime-rust");
    let quote_path = |path: &Path| {
        serde_json::to_string(&frontend::path_for_frontend(path)).map_err(|e| e.to_string())
    };
    let mut manifest = format!(
        "[package]\nname = {package:?}\nversion = \"0.0.0\"\nedition = \"2024\"\n[dependencies]\nryu-js = \"=1.0.2\"\n"
    );
    if uses_runtime {
        let runtime = fs::canonicalize(&runtime_root).map_err(|e| e.to_string())?;
        let features = if source.contains("runtime::sqlite_") {
            ", features = [\"sqlite\"]"
        } else {
            ""
        };
        manifest.push_str(&format!("scriptc-runtime = {{ path = {}, default-features = false{features} }}\n[patch.crates-io]\nzlib-rs = {{path = {}}}\nurl = {{path = {}}}\n", quote_path(&runtime)?, quote_path(&runtime.join("vendor/zlib-rs"))?, quote_path(&runtime.join("vendor/url"))?));
        fs::copy(runtime.join("Cargo.lock"), work.join("Cargo.lock")).map_err(|e| e.to_string())?;
    }
    manifest.push_str("[profile.dev]\ndebug = 0\nincremental = false\n[profile.release]\ndebug = 0\nincremental = false\nopt-level = 3\n");
    fs::write(work.join("Cargo.toml"), manifest).map_err(|e| e.to_string())?;
    let target = std::env::var_os("SCRIPTC_NATIVE_CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| compiler_root.join("target/native-programs"));
    // The only executable used by the compiler is the Rust build toolchain.
    // Offline dependencies are preloaded by the documented Cargo fetch step.
    let mut command = Command::new(cargo_executable());
    command
        .current_dir(work)
        .args([
            "rustc",
            "--offline",
            "--quiet",
            "--jobs",
            "1",
            "--manifest-path",
        ])
        .arg(work.join("Cargo.toml"))
        .arg("--target-dir")
        .arg(&target)
        .arg("--bin")
        .arg(&package)
        .env("CARGO_INCREMENTAL", "0")
        .env("CARGO_BUILD_JOBS", "1");
    if release {
        command.arg("--release");
    }
    // Generated programs intentionally contain many compatibility helpers and
    // mechanically named symbols. Asking rustc to lint those adds tens of
    // thousands of diagnostics and significant peak memory on large graphs.
    // Keep generated applications inside a predictable memory envelope. A
    // single LLVM unit retains the entire generated graph until the end; the
    // red-dev acceptance crate exceeded 20 GiB that way. Sixteen units, still
    // under Cargo's one-worker jobserver, release backend state incrementally
    // and completed the same crate below an 18 GiB observed peak. Builders can
    // override the partition count for a different memory/size tradeoff.
    let codegen_units = std::env::var("SCRIPTC_NATIVE_CODEGEN_UNITS")
        .ok()
        .filter(|value| value.parse::<usize>().is_ok_and(|units| units > 0))
        .unwrap_or_else(|| "16".to_owned());
    let codegen_units_flag = format!("codegen-units={codegen_units}");
    command.args([
        "--",
        "-A",
        "warnings",
        "-C",
        codegen_units_flag.as_str(),
        "-C",
        "strip=symbols",
    ]);
    if cfg!(all(windows, target_env = "msvc")) {
        command.args(["-C", "link-arg=/STACK:16777216"]);
    }
    let output = command
        .output()
        .map_err(|e| format!("SCN0003: cannot start Cargo: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "SCN0003: Rust compilation failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let name = if cfg!(windows) {
        format!("{package}.exe")
    } else {
        package
    };
    let binary = work.join(if cfg!(windows) {
        "program.exe"
    } else {
        "program"
    });
    fs::copy(
        target
            .join(if release { "release" } else { "debug" })
            .join(name),
        &binary,
    )
    .map_err(|e| e.to_string())?;
    Ok(binary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_modules_keep_root_support_and_group_function_owners() {
        let first = "\nfn first() {}\n";
        let second = "\nfn second() { first(); }\n";
        let source = format!("support\n{first}{second}fn main() {{ second(); }}\n");
        let first_start = "support\n".len();
        let ranges = vec![
            emit::RustFunctionRange {
                source_file: "a.ts".into(),
                start: first_start,
                end: first_start + first.len(),
            },
            emit::RustFunctionRange {
                source_file: "b.ts".into(),
                start: first_start + first.len(),
                end: first_start + first.len() + second.len(),
            },
        ];
        let chunk = |id: &str, module: &str| emit::chunks::Chunk {
            id: id.into(),
            weight: 1,
            source_bytes: 1,
            contains_eager_modules: true,
            contains_lazy_modules: false,
            modules: vec![module.into()],
            static_chunks: vec![],
            dynamic_chunks: vec![],
        };
        let partition = emit::chunks::ChunkPlan {
            schema_version: 1,
            weight_model: "test",
            target_weight: 1,
            total_weight: 2,
            total_source_bytes: 2,
            chunks: vec![
                chunk("scriptc_chunk_0000", "a.ts"),
                chunk("scriptc_chunk_0001", "b.ts"),
            ],
        };
        let (root, modules) = split_rust_source(&source, &ranges, &partition).unwrap();
        assert_eq!(modules.len(), 2);
        assert!(root.contains("support\nmod scriptc_functions_0000;"));
        assert!(root.contains("fn main() { second(); }"));
        assert!(!root.contains("fn first()"));
        assert!(modules[0].source.contains("fn first()"));
        assert!(modules[1].source.contains("fn second() { first(); }"));
    }
}
