#![forbid(unsafe_code)]

mod emit;
mod frontend;
mod ir;
mod project;

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

fn main() -> ExitCode {
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
        .ok_or("usage: scriptc build <file.ts|file.js> [--project <tsconfig>] [--emit bin|ir|rust] --out <path>")?;
    if command == "--version" {
        println!(
            "scriptc native 0.1.1-rust.0; frontend {}; IR {}; engine none",
            frontend::REVISION,
            ir::VERSION
        );
        return Ok(());
    }
    if command != "build" {
        return Err("SCN0001: only build is available in the first native executable".into());
    }
    let input = fs::canonicalize(PathBuf::from(
        args.next().ok_or("SCN0001: missing input file")?,
    ))
    .map_err(|e| format!("SCN0001: input: {e}"))?;
    if !matches!(
        input.extension().and_then(|e| e.to_str()),
        Some("ts" | "js" | "mts" | "mjs")
    ) {
        return Err("SCN0001: expected a TypeScript/JavaScript file".into());
    }
    let mut kind = String::from("bin");
    let mut out = None;
    let mut project_path = None;
    while let Some(arg) = args.next() {
        if arg == "--emit" {
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
        } else if arg != "--no-engine" {
            return Err(format!("SCN0001: unsupported option {arg:?}"));
        }
    }
    if !matches!(kind.as_str(), "bin" | "ir" | "rust") {
        return Err("SCN0001: --emit expects bin, ir or rust".into());
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
    if kind == "bin" && (out.with_extension("rs") == out || out.with_extension("ir.json") == out) {
        return Err("SCN0001: binary output collides with an IR/Rust sidecar".into());
    }
    if cfg!(windows)
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
    let module = frontend::lower(&input, work.path(), project.as_deref())?;
    ir::validate(&module).map_err(|e| format!("SCN9001: {e}"))?;
    let json = serde_json::to_vec_pretty(&module).map_err(|e| e.to_string())?;
    let rust = emit::rust(&module).map_err(|e| format!("SCN9001: {e}"))?;
    let (ir_path, rust_path, binary_path) = match kind.as_str() {
        "ir" => {
            atomic_write(&out, &json)?;
            (Some(out.clone()), None, None)
        }
        "rust" => {
            atomic_write(&out, rust.as_bytes())?;
            (None, Some(out.clone()), None)
        }
        _ => {
            let ir_path = out.with_extension("ir.json");
            let rust_path = out.with_extension("rs");
            // Compile before publishing any artifacts. A failed build leaves
            // previous successful outputs intact.
            let binary = compile(&rust, work.path())?;
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
            atomic_write(&rust_path, rust.as_bytes())?;
            staged.persist(&out).map_err(|e| e.to_string())?;
            (Some(ir_path), Some(rust_path), Some(out.clone()))
        }
    };
    println!(
        "{}",
        serde_json::json!({ "compiler": "rust", "backend": "rust", "engine": "none", "externalFfi": false,
        "frontendRevision": frontend::REVISION, "irVersion": ir::VERSION,
        "project": project,
        "irPath": ir_path, "rustPath": rust_path, "binaryPath": binary_path })
    );
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("output has no parent")?)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn compile(source: &str, work: &Path) -> Result<PathBuf, String> {
    fs::create_dir(work.join("src")).map_err(|e| e.to_string())?;
    fs::write(work.join("src/main.rs"), source).map_err(|e| e.to_string())?;
    fs::write(work.join("Cargo.toml"), "[package]\nname = \"scriptc_program\"\nversion = \"0.0.0\"\nedition = \"2024\"\n[dependencies]\nryu-js = \"=1.0.2\"\n[profile.dev]\ndebug = 0\nincremental = false\n").map_err(|e| e.to_string())?;
    // The only executable used by the compiler is the Rust build toolchain.
    // Offline dependencies were fetched while building this compiler itself.
    let output = Command::new("cargo")
        .current_dir(work)
        .args([
            "build",
            "--offline",
            "--quiet",
            "--jobs",
            "1",
            "--manifest-path",
        ])
        .arg(work.join("Cargo.toml"))
        .arg("--target-dir")
        .arg(work.join("target"))
        .env("CARGO_INCREMENTAL", "0")
        .env("CARGO_BUILD_JOBS", "1")
        .output()
        .map_err(|e| format!("SCN0003: cannot start Cargo: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "SCN0003: Rust compilation failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let name = if cfg!(windows) {
        "scriptc_program.exe"
    } else {
        "scriptc_program"
    };
    Ok(work.join("target/debug").join(name))
}
