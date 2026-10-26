//! Independent entry probes use isolated Rust frontend processes, never recovery IR.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    ffi::OsString,
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    name: String,
    input: PathBuf,
    project: Option<PathBuf>,
    /// A demand adapter imports original code; no adapter is executed.
    #[serde(default = "module_scope")]
    scope: String,
}

fn module_scope() -> String {
    "module-entry".into()
}

struct Prepared {
    name: String,
    input: PathBuf,
    project: Option<PathBuf>,
    scope: String,
    preparation_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    name: String,
    input: String,
    project: Option<String>,
    scope: String,
    status: &'static str,
    elapsed_ms: u128,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Occurrence {
    diagnostic: String,
    roots: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Family {
    code: String,
    detail: String,
    occurrences: Vec<Occurrence>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    kind: &'static str,
    schema_version: u32,
    compiler: &'static str,
    compiler_version: &'static str,
    compiler_executable: String,
    frontend_revision: &'static str,
    ir_version: u32,
    engine: &'static str,
    fallback: bool,
    scope: &'static str,
    jobs: usize,
    elapsed_ms: u128,
    ir_accepted: usize,
    blocked: usize,
    timed_out: usize,
    tool_failures: usize,
    probes: Vec<Probe>,
    families: Vec<Family>,
}

pub(super) fn run(mut args: impl Iterator<Item = OsString>) -> Result<(), String> {
    let manifest = PathBuf::from(args.next().ok_or(
        "SCN0001: usage: scriptc survey <manifest.json> --out <report.json> [--jobs 1..3] [--timeout-seconds N]",
    )?);
    let mut out = None;
    let mut jobs = 1;
    let mut timeout = 600;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--out") => {
                out = Some(PathBuf::from(
                    args.next().ok_or("SCN0001: missing --out value")?,
                ))
            }
            Some("--jobs") => jobs = positive(&mut args, "--jobs")?,
            Some("--timeout-seconds") => timeout = positive(&mut args, "--timeout-seconds")?,
            Some("--no-engine") => {}
            _ => return Err(format!("SCN0001: unsupported survey option {arg:?}")),
        }
    }
    if jobs > 3 {
        return Err("SCN0001: survey supports one to three isolated frontend workers".into());
    }
    let manifest =
        fs::canonicalize(&manifest).map_err(|e| format!("SCN0001: survey manifest: {e}"))?;
    let base = manifest
        .parent()
        .ok_or("SCN0001: survey manifest has no parent")?;
    let parsed: Manifest =
        serde_json::from_slice(&fs::read(&manifest).map_err(|e| format!("SCN0001: {e}"))?)
            .map_err(|e| format!("SCN0001: survey manifest: {e}"))?;
    if parsed.entries.is_empty() {
        return Err("SCN0001: survey manifest needs at least one entry".into());
    }
    let mut names = HashSet::new();
    let mut entries = Vec::new();
    for entry in parsed.entries {
        if entry.name.trim().is_empty() || !names.insert(entry.name.clone()) {
            return Err("SCN0001: survey entry names must be nonempty and unique".into());
        }
        if !matches!(
            entry.scope.as_str(),
            "module-entry" | "application-entry" | "demand-adapter"
        ) {
            return Err(
                "SCN0001: survey scope expects module-entry, application-entry or demand-adapter"
                    .into(),
            );
        }
        let candidate = base.join(entry.input);
        let mut preparation_error = None;
        let input = fs::canonicalize(&candidate).unwrap_or_else(|error| {
            preparation_error = Some(format!("cannot load survey entry: {error}"));
            candidate
        });
        let name = input.to_string_lossy();
        if !matches!(
            input.extension().and_then(|x| x.to_str()),
            Some("ts" | "js" | "mts" | "mjs" | "cjs")
        ) || [".d.ts", ".d.mts", ".d.cts"]
            .iter()
            .any(|ext| name.ends_with(ext))
        {
            preparation_error =
                Some("survey entries must be executable TypeScript/JavaScript source files".into());
        }
        let explicit = entry.project.map(|p| base.join(p));
        let project =
            crate::project::discover(&input, explicit.as_deref()).unwrap_or_else(|error| {
                preparation_error = Some(error);
                explicit
            });
        entries.push(Prepared {
            name: entry.name,
            input,
            project,
            scope: entry.scope,
            preparation_error,
        });
    }
    let out = out.ok_or("SCN0001: survey --out is required")?;
    let out = std::env::current_dir()
        .map_err(|e| e.to_string())?
        .join(out);
    if out.extension().and_then(|ext| ext.to_str()) != Some("json") {
        return Err("SCN0001: survey output must be a .json report".into());
    }
    if fs::canonicalize(&out).is_ok_and(|path| {
        path == manifest
            || entries
                .iter()
                .any(|e| path == e.input || Some(&path) == e.project.as_ref())
    }) {
        return Err(
            "SCN0001: survey output would overwrite source, configuration or manifest".into(),
        );
    }
    if out.exists() {
        let old = fs::read(&out)
            .ok()
            .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok());
        if !old.is_some_and(|value| value["kind"] == "native-survey" && value["schemaVersion"] == 1)
        {
            return Err("SCN0001: survey only replaces an existing native-survey report".into());
        }
    }
    let parent = out.parent().ok_or("SCN0001: survey output has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let work = tempfile::Builder::new()
        .prefix("scriptc-survey-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    let probes = parallel_map(&entries, jobs, |index, entry| {
        let result = probe(
            entry,
            index,
            &executable,
            work.path(),
            Duration::from_secs(timeout as u64),
        );
        eprintln!(
            "{}",
            serde_json::json!({"surveyEntry": entry.name, "status": result.status, "elapsedMs": result.elapsed_ms})
        );
        result
    })?;
    let families = families(&probes);
    let count = |status| probes.iter().filter(|p| p.status == status).count();
    let report = Report {
        kind: "native-survey",
        schema_version: 1,
        compiler: "rust",
        compiler_version: env!("CARGO_PKG_VERSION"),
        compiler_executable: crate::frontend::path_for_frontend(&executable),
        frontend_revision: crate::frontend::REVISION,
        ir_version: crate::ir::VERSION,
        engine: "none",
        fallback: false,
        scope: "Independent original-project entry probes; each validates IR and Rust source generation without Cargo or application execution. Each failed probe retains its first refusal. Unused exported bodies are not checked unless demanded by an explicit adapter. This is neither a complete gap count nor a binary/build certificate. Shared upstream refusals are deduplicated, not bypassed.",
        jobs,
        elapsed_ms: start.elapsed().as_millis(),
        ir_accepted: count("ir-accepted"),
        blocked: count("blocked"),
        timed_out: count("timed-out"),
        tool_failures: count("tool-failure"),
        probes,
        families,
    };
    crate::atomic_write(
        &out,
        &serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )?;
    println!(
        "{}",
        serde_json::json!({"survey": out, "compiler": "rust", "engine": "none", "jobs": jobs,
        "irAccepted": report.ir_accepted, "blocked": report.blocked, "timedOut": report.timed_out,
        "toolFailures": report.tool_failures, "diagnosticFamilies": report.families.len()})
    );
    if report.blocked + report.timed_out + report.tool_failures > 0 {
        return Err(
            "SCN0004: survey completed with blocked or incomplete entry probes; see report".into(),
        );
    }
    Ok(())
}

fn positive(args: &mut impl Iterator<Item = OsString>, option: &str) -> Result<usize, String> {
    args.next()
        .and_then(|v| v.to_str().and_then(|s| s.parse().ok()))
        .filter(|n| *n > 0)
        .ok_or_else(|| format!("SCN0001: {option} needs a positive integer"))
}

fn parallel_map<T: Sync, R: Send>(
    items: &[T],
    jobs: usize,
    f: impl Fn(usize, &T) -> R + Sync,
) -> Result<Vec<R>, String> {
    let next = AtomicUsize::new(0);
    thread::scope(|scope| {
        let handles = (0..jobs.min(items.len()))
            .map(|_| {
                let next = &next;
                let f = &f;
                scope.spawn(move || {
                    let mut results = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(item) = items.get(index) else { break };
                        results.push((index, f(index, item)));
                    }
                    results
                })
            })
            .collect::<Vec<_>>();
        let mut results = Vec::new();
        for handle in handles {
            results.extend(
                handle
                    .join()
                    .map_err(|_| "SCN0004: survey worker panicked")?,
            );
        }
        results.sort_by_key(|(index, _)| *index);
        Ok(results.into_iter().map(|(_, value)| value).collect())
    })
}

fn probe(
    entry: &Prepared,
    index: usize,
    executable: &Path,
    work: &Path,
    timeout: Duration,
) -> Probe {
    let start = Instant::now();
    let mut result = Probe {
        name: entry.name.clone(),
        input: crate::frontend::path_for_frontend(&entry.input),
        project: entry
            .project
            .as_deref()
            .map(crate::frontend::path_for_frontend),
        scope: entry.scope.clone(),
        status: "tool-failure",
        elapsed_ms: 0,
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
    };
    let dir = work.join(index.to_string());
    if let Some(error) = &entry.preparation_error {
        result.stderr = error.clone();
        result.elapsed_ms = start.elapsed().as_millis();
        return result;
    }
    let run = || -> Result<(&'static str, Option<i32>), String> {
        fs::create_dir(&dir).map_err(|e| e.to_string())?;
        let stdout = File::create(dir.join("stdout")).map_err(|e| e.to_string())?;
        let stderr = File::create(dir.join("stderr")).map_err(|e| e.to_string())?;
        let mut command = Command::new(executable);
        command
            .arg("build")
            .arg(&entry.input)
            .args(["--no-engine", "--emit", "ir", "--out"])
            .arg(dir.join("module.json"));
        if let Some(project) = &entry.project {
            command.arg("--project").arg(project);
        }
        command.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let child = command
            .spawn()
            .map_err(|e| format!("cannot start native frontend: {e}"))?;
        match wait_frontend(child, timeout)? {
            Some(status) => {
                let output = fs::read_to_string(dir.join("stdout")).unwrap_or_default();
                if status.success() {
                    let metadata: serde_json::Value = serde_json::from_str(output.trim())
                        .map_err(|e| format!("invalid native metadata: {e}"))?;
                    if metadata["engine"] != "none"
                        || metadata["compiler"] != "rust"
                        || metadata["irVersion"] != crate::ir::VERSION
                        || !dir.join("module.json").is_file()
                    {
                        return Err(
                            "native frontend did not confirm an engine-free IR result".into()
                        );
                    }
                    return Ok(("ir-accepted", status.code()));
                }
                let stderr = fs::read_to_string(dir.join("stderr")).unwrap_or_default();
                Ok((classify(&stderr), status.code()))
            }
            None => Ok(("timed-out", None)),
        }
    };
    match run() {
        Ok((status, code)) => {
            result.status = status;
            result.exit_code = code;
        }
        Err(error) => result.stderr = error,
    }
    result.stdout = fs::read_to_string(dir.join("stdout")).unwrap_or_default();
    let captured = fs::read_to_string(dir.join("stderr")).unwrap_or_default();
    if !result.stderr.is_empty() && !captured.is_empty() {
        result.stderr.push('\n');
    }
    result.stderr.push_str(&captured);
    result.elapsed_ms = start.elapsed().as_millis();
    result
}

struct RunningFrontend(Child);
impl Drop for RunningFrontend {
    fn drop(&mut self) {
        // Reap even when metadata validation, polling or cancellation fails.
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn wait_frontend(child: Child, timeout: Duration) -> Result<Option<ExitStatus>, String> {
    let mut child = RunningFrontend(child);
    let start = Instant::now();
    loop {
        match child.0.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Err(error) => return Err(format!("cannot wait for native frontend: {error}")),
            Ok(None) if start.elapsed() >= timeout => {
                let stopped = child.0.kill();
                let reaped = child.0.wait();
                reaped.map_err(|e| {
                    format!("cannot reap timed-out native frontend: {e}; stop result: {stopped:?}")
                })?;
                stopped.map_err(|e| format!("cannot stop timed-out native frontend: {e}"))?;
                return Ok(None);
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
        }
    }
}

fn classify(stderr: &str) -> &'static str {
    if stderr.contains("SCN9001") || stderr.contains("panicked at") {
        return "tool-failure";
    }
    if stderr.lines().any(|line| {
        line.starts_with("SCN1001:") || line.starts_with("SCN0002:") || line.contains("error TS")
    }) {
        "blocked"
    } else {
        "tool-failure"
    }
}

fn diagnostic_key(line: &str) -> Option<(String, String)> {
    if let Some(body) = line.strip_prefix("SCN1001: ") {
        let detail = body.split_once(": ").map_or(body, |(_, detail)| detail);
        return Some(("SCN1001".into(), detail.into()));
    }
    if let Some((_, body)) = line.split_once("error TS") {
        let (code, detail) = body.split_once(':')?;
        if code.chars().all(|c| c.is_ascii_digit()) && !code.is_empty() {
            return Some((format!("TS{code}"), detail.trim().into()));
        }
    }
    if let Some(body) = line.strip_prefix("SCN0002:") {
        return Some(("SCN0002".into(), body.trim().into()));
    }
    None
}

fn families(probes: &[Probe]) -> Vec<Family> {
    let mut groups: BTreeMap<(String, String), BTreeMap<String, Vec<String>>> = BTreeMap::new();
    for probe in probes.iter().filter(|probe| probe.status == "blocked") {
        for line in probe.stderr.lines() {
            if let Some(key) = diagnostic_key(line) {
                let roots = groups
                    .entry(key)
                    .or_default()
                    .entry(line.into())
                    .or_default();
                if !roots.contains(&probe.name) {
                    roots.push(probe.name.clone());
                }
            }
        }
    }
    groups
        .into_iter()
        .map(|((code, detail), sites)| Family {
            code,
            detail,
            occurrences: sites
                .into_iter()
                .map(|(diagnostic, mut roots)| {
                    roots.sort();
                    Occurrence { diagnostic, roots }
                })
                .collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parallel_queue_bounds_workers_and_preserves_input_order() {
        use std::sync::{Barrier, atomic::AtomicUsize};
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let barrier = Barrier::new(3);
        let values = parallel_map(&(0..12).collect::<Vec<_>>(), 3, |index, value| {
            let now = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            if index < 3 {
                barrier.wait();
            }
            thread::sleep(Duration::from_millis(2));
            active.fetch_sub(1, Ordering::SeqCst);
            value * 2
        })
        .unwrap();
        assert_eq!(values, (0..12).map(|v| v * 2).collect::<Vec<_>>());
        assert_eq!(peak.load(Ordering::SeqCst), 3);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn grouping_retains_distinct_sites_and_all_affected_roots() {
        let probe = |name: &str, site: &str| Probe {
            name: name.into(),
            input: name.into(),
            project: None,
            scope: module_scope(),
            status: "blocked",
            elapsed_ms: 0,
            exit_code: Some(1),
            stdout: String::new(),
            stderr: format!(
                "SCN1001: C:/deps/shared.js:{site}: not ported (CallExpression); native subset only, no fallback\nnative reachability: {name}"
            ),
        };
        let groups = families(&[probe("b", "1..4"), probe("a", "1..4"), probe("c", "9..12")]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].occurrences.len(), 2);
        assert_eq!(groups[0].occurrences[0].roots, ["a", "b"]);
        assert_eq!(classify("SCN9001: broken IR"), "tool-failure");
        assert_eq!(classify("thread 'main' panicked at a.rs:2"), "tool-failure");
        assert_eq!(classify("main.ts(2,1): error TS2339: no field"), "blocked");
        assert_eq!(classify("access denied"), "tool-failure");
    }

    #[test]
    #[ignore = "subprocess fixture for timeout_reaps_frontend"]
    fn timeout_child() {
        thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn timeout_reaps_frontend() {
        let start = Instant::now();
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "survey::tests::timeout_child"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(
            wait_frontend(child, Duration::from_millis(30))
                .unwrap()
                .is_none()
        );
        assert!(start.elapsed() < Duration::from_secs(10));
    }
}
