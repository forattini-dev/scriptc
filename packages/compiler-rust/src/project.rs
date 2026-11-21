//! Project loading uses the pinned Rust tsconfig parser and filesystem host.
use source_frontend::{
    frontend::{
        bundled,
        compiler::{ProgramOptions, new_cached_fs_compiler_host},
        tsoptions::{ParseConfigHost, get_parsed_command_line_of_config_file},
        vfs::{Entries, FileInfo, Fs, FsError, osvfs_fs},
    },
    options::{CompilerOptions, Tristate},
    prelude::{JsxEmit, source_file_info},
    program, transpile,
};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    rc::Rc,
    time::SystemTime,
};

use crate::frontend::path_for_frontend;

struct Host {
    fs: Rc<dyn Fs>,
    cwd: String,
}

impl ParseConfigHost for Host {
    fn fs(&self) -> Rc<dyn Fs> {
        self.fs.clone()
    }
    fn get_current_directory(&self) -> String {
        self.cwd.clone()
    }
}

/// Read-only execution overlay for TSX. The checked program keeps the original
/// typed source; only the lowering program sees TypeScript's automatic JSX
/// runtime calls. Paths stay unchanged, so module resolution and the contract
/// catalog continue to refer to the authoritative project files.
struct JsxExecutionFs {
    inner: Rc<dyn Fs>,
    outputs: HashMap<String, String>,
}

impl Fs for JsxExecutionFs {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.inner.use_case_sensitive_file_names()
    }
    fn file_exists(&self, path: &str) -> bool {
        self.inner.file_exists(path)
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        if let Some(output) = self.outputs.get(path) {
            return (output.clone(), true);
        }
        self.inner.read_file(path)
    }
    fn write_file(&self, path: &str, data: &str) -> Result<(), FsError> {
        self.inner.write_file(path, data)
    }
    fn append_file(&self, path: &str, data: &str) -> Result<(), FsError> {
        self.inner.append_file(path, data)
    }
    fn remove(&self, path: &str) -> Result<(), FsError> {
        self.inner.remove(path)
    }
    fn chtimes(
        &self,
        path: &str,
        atime: Option<SystemTime>,
        mtime: Option<SystemTime>,
    ) -> Result<(), FsError> {
        self.inner.chtimes(path, atime, mtime)
    }
    fn directory_exists(&self, path: &str) -> bool {
        self.inner.directory_exists(path)
    }
    fn get_accessible_entries(&self, path: &str) -> Entries {
        self.inner.get_accessible_entries(path)
    }
    fn stat(&self, path: &str) -> Option<FileInfo> {
        self.inner.stat(path)
    }
    fn realpath(&self, path: &str) -> String {
        self.inner.realpath(path)
    }
}

pub(crate) fn contains_jsx(node: source_frontend::prelude::Node) -> bool {
    use source_frontend::prelude::SyntaxKind;
    if matches!(
        node.kind(),
        SyntaxKind::JsxElement | SyntaxKind::JsxSelfClosingElement | SyntaxKind::JsxFragment
    ) {
        return true;
    }
    let mut found = false;
    node.for_each_child(&mut |child| {
        found = contains_jsx(child);
        found
    });
    found
}

pub fn discover(input: &Path, explicit: Option<&Path>) -> Result<Option<PathBuf>, String> {
    if let Some(path) = explicit {
        let config = if path.is_dir() {
            path.join("tsconfig.json")
        } else {
            path.to_path_buf()
        };
        return std::fs::canonicalize(&config)
            .map(Some)
            .map_err(|e| format!("SCN0001: project {}: {e}", config.display()));
    }
    for directory in input.parent().into_iter().flat_map(Path::ancestors) {
        let config = directory.join("tsconfig.json");
        if config.is_file() {
            return std::fs::canonicalize(config)
                .map(Some)
                .map_err(|e| e.to_string());
        }
    }
    Ok(None)
}

fn project_native_library(config: &Path) -> Option<String> {
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        _ => return None,
    };
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "arm" => "arm",
        _ => return None,
    };
    let package = format!("native-preview-{platform}-{architecture}");
    for directory in config.parent()?.ancestors() {
        let modules = directory.join("node_modules");
        let direct = modules.join("@typescript").join(&package).join("lib");
        if direct.join("lib.d.ts").is_file() {
            return Some(path_for_frontend(&direct));
        }
        // Bun keeps optional platform packages in its content-addressed store
        // even when it does not expose a top-level symlink for them.
        let store = modules.join(".bun");
        let prefix = format!("@typescript+{package}@");
        let Ok(entries) = std::fs::read_dir(store) else {
            continue;
        };
        let mut entries = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let candidate = entry
                .path()
                .join("node_modules")
                .join("@typescript")
                .join(&package)
                .join("lib");
            if candidate.join("lib.d.ts").is_file() {
                return Some(path_for_frontend(&candidate));
            }
        }
    }
    None
}

pub struct Loaded {
    pub options: ProgramOptions,
    pub checked: &'static source_frontend::core::GoProgram,
    /// Only the loader can designate its generated ambient declarations.
    pub console_prelude: Option<String>,
}

pub fn load(input: &Path, work: &Path, project: Option<&Path>) -> Result<Loaded, String> {
    let source = path_for_frontend(input);
    let mut console_prelude = None;
    let config_path = if let Some(project) = project {
        project.to_path_buf()
    } else {
        let prelude = work.join("native-console.d.ts");
        console_prelude = Some(path_for_frontend(&prelude));
        // Compatible with global Console declarations brought in by type references.
        std::fs::write(&prelude, "interface Console { log(...values: unknown[]): void; info(...values: unknown[]): void; debug(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void; }\ndeclare var console: Console;\n").map_err(|e| e.to_string())?;
        let config = work.join("tsconfig.json");
        let json = serde_json::json!({ "compilerOptions": {
            "target": "es2022", "lib": ["es2022"], "strict": true, "types": [],
            "noEmit": true, "allowJs": true, "checkJs": true,
            "module": "esnext", "moduleResolution": "bundler", "allowImportingTsExtensions": true,
            "verbatimModuleSyntax": true,
        }, "files": [source, path_for_frontend(&prelude)] });
        std::fs::write(
            &config,
            serde_json::to_vec(&json).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        config
    };
    // Type directive discovery (`node_modules/@types`) is rooted at the
    // project's directory.  Using the compiler process cwd made an explicit
    // project work only when scriptc happened to be launched from that
    // workspace; package-local Bun/Node globals then disappeared when the
    // same command was launched from scriptc itself or an IDE.
    let cwd = path_for_frontend(
        config_path
            .parent()
            .ok_or_else(|| "SCN0001: project configuration has no directory".to_string())?,
    );
    let fs = bundled::wrap_fs(osvfs_fs());
    let host = Host {
        fs: fs.clone(),
        cwd: cwd.clone(),
    };
    let overrides = CompilerOptions {
        no_emit: Tristate::True,
        checkers: Some(1),
        ..Default::default()
    };
    let (config, errors) = get_parsed_command_line_of_config_file(
        &path_for_frontend(&config_path),
        Some(&overrides),
        None,
        &host,
        None,
    );
    if !errors.is_empty() {
        return Err(errors
            .iter()
            .map(|d| {
                format!(
                    "error TS{}: {}",
                    d.code,
                    d.localize(&source_frontend::locale::DEFAULT)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let mut config =
        config.ok_or_else(|| "SCN0001: project configuration could not be loaded".to_string())?;
    // The native frontend models TypeScript's implicit `node_modules/@types`
    // lookup with a `*` entry.  A missing `types` option means the implicit
    // lookup is enabled; an explicit empty array still disables it.
    let compiler = Rc::make_mut(&mut config.parsed_config.compiler_options);
    if compiler.types.is_none() {
        compiler.types = Some(vec!["*".into()]);
    }
    let mut roots = vec![source];
    // Keep ambient project declarations, while excluding unrelated executable roots/tests.
    roots.extend(
        config
            .parsed_config
            .file_names
            .iter()
            .filter(|name| is_declaration(name))
            .cloned(),
    );
    roots.sort();
    roots.dedup();
    let config = config.with_file_names(roots);
    let library_path = std::env::var("SCRIPTC_TYPESCRIPT_LIB")
        .ok()
        .filter(|path| Path::new(path).join("lib.d.ts").is_file())
        .or_else(|| project_native_library(&config_path))
        .unwrap_or_else(bundled::lib_path);
    if std::env::var_os("SCRIPTC_TRACE_PROJECT").is_some() {
        eprintln!("scriptc TypeScript library: {library_path}");
    }
    let host = new_cached_fs_compiler_host(&cwd, fs, &library_path, None, None, None);
    let options = ProgramOptions {
        host,
        config: Rc::new(config),
        use_source_of_project_reference: false,
        single_threaded: Tristate::True,
        typings_location: String::new(),
        project_name: String::new(),
        create_module_resolver: None,
        skip_module_resolution: false,
    };
    let program = version(options.clone());
    Ok(Loaded {
        options,
        checked: program,
        console_prelude,
    })
}

/// The typed program has already passed diagnostics. Resolve package runtime
/// exports with the same Rust resolver, keeping declarations for checking only.
pub fn execution_view(mut options: ProgramOptions) -> &'static source_frontend::core::GoProgram {
    // Runtime lowering needs the executable source behind composite project
    // references. TypeScript's ordinary consumer view redirects workspace
    // imports to declaration outputs such as node_modules/.ts-dist/*.d.ts;
    // following the reference back to source preserves the checked public
    // contract while giving the native module graph an actual body to lower.
    options.use_source_of_project_reference = true;
    let mut config = options
        .config
        .with_file_names(options.config.parsed_config.file_names.clone());
    let compiler = Rc::make_mut(&mut config.parsed_config.compiler_options);
    compiler.no_dts_resolution = Tristate::True;
    compiler.allow_js = Tristate::True;
    let conditions = compiler.custom_conditions.get_or_insert_default();
    if !conditions.iter().any(|condition| condition == "node") {
        conditions.push("node".into());
    }
    // Consumers are checked against the public declarations in the first
    // program. JS bodies supply separate inference for native lowering.
    compiler.check_js = Tristate::False;
    // A compiler must load package implementations beyond tsc's default
    // zero-depth JS inference boundary. The loader deduplicates cycles.
    compiler.max_node_module_js_depth = Some(i64::MAX);
    options.config = Rc::new(config);

    // TypeScript's Node resolver performs extension substitution even with
    // `noDtsResolution`: an export that names `dist/index.js` can therefore
    // still be recorded as the adjacent `dist/index.d.ts`.  Keep that file as
    // the checker contract, but load the executable sibling as a separate
    // root so module planning can select its body.  Only resolved declaration
    // targets are considered; this does not search for or invent package
    // entry points outside the authoritative resolver result.
    let initial = version(options.clone());
    let (runtime_roots, mut jsx_files) = {
        let _scope = source_frontend::core::enter_program(Some(initial));
        let mut roots = Vec::new();
        let mut jsx = HashSet::new();
        for file in program::source_files() {
            let file_name = source_file_info(file).file_name.to_string();
            if is_declaration(&file_name) {
                continue;
            }
            if file_name.ends_with(".tsx") {
                let found = contains_jsx(file);
                if std::env::var_os("SCRIPTC_TRACE_JSX").is_some() {
                    eprintln!("scriptc jsx source: {file_name} contains={found}");
                }
                if found {
                    jsx.insert(file_name);
                }
            }
            for statement in file.statements() {
                let Some(specifier) = crate::frontend::modules::runtime_specifier(statement) else {
                    continue;
                };
                let Some(resolved) =
                    program::get_resolved_module_from_module_specifier(file, specifier)
                else {
                    continue;
                };
                if let Some(runtime) = resolve_runtime_module(
                    &source_file_info(file).file_name,
                    specifier.text(),
                    &resolved.resolved_file_name,
                ) && Path::new(&runtime).is_file()
                {
                    roots.push(runtime);
                }
            }
            for (_, specifier) in crate::frontend::modules::dynamic_imports(file) {
                let declaration =
                    program::get_resolved_module_from_module_specifier(file, specifier)
                        .map(|resolved| resolved.resolved_file_name)
                        .unwrap_or_default();
                if let Some(runtime) = resolve_runtime_module(
                    &source_file_info(file).file_name,
                    specifier.text(),
                    &declaration,
                ) && Path::new(&runtime).is_file()
                {
                    roots.push(runtime);
                }
            }
        }
        roots.sort();
        roots.dedup();
        (roots, jsx)
    };
    jsx_files.extend(
        runtime_roots
            .iter()
            .filter(|path| path.ends_with(".tsx"))
            .cloned(),
    );
    if std::env::var_os("SCRIPTC_TRACE_JSX").is_some() {
        eprintln!("scriptc jsx execution files: {}", jsx_files.len());
    }
    if runtime_roots.is_empty() && jsx_files.is_empty() {
        return initial;
    }
    let mut roots = options.config.parsed_config.file_names.clone();
    roots.extend(runtime_roots);
    roots.sort();
    roots.dedup();
    options.config = Rc::new(options.config.with_file_names(roots));
    if !jsx_files.is_empty() {
        let base = options.host.fs();
        let current_directory = options.host.get_current_directory();
        let default_library_path = options.host.default_library_path();
        let mut jsx_options = options
            .config
            .parsed_config
            .compiler_options
            .as_ref()
            .clone();
        // Preserve the project's jsxImportSource, but lower `preserve` syntax
        // into its standard automatic runtime ABI for the execution checker.
        jsx_options.jsx = JsxEmit::REACT_JSX;
        // Transpilation owns short-lived frontend program state. Complete it
        // before the execution program starts parsing through the overlay;
        // invoking it recursively from Fs::read_file would corrupt the active
        // parser's global program store.
        let mut outputs = HashMap::new();
        for path in &jsx_files {
            let (source, ok) = base.read_file(path);
            if !ok {
                continue;
            }
            let output = transpile::transpile_module(
                &source_frontend::gostd::context::background(),
                &source,
                transpile::Options {
                    compiler_options: Some(jsx_options.clone()),
                    file_name: path.clone(),
                    report_diagnostics: false,
                },
            )
            .map(|output| output.output_text)
            .unwrap_or(source);
            if std::env::var_os("SCRIPTC_TRACE_JSX").is_some() {
                eprintln!("scriptc jsx overlay transformed: {path}");
            }
            outputs.insert(path.clone(), output);
        }
        let overlay: Rc<dyn Fs> = Rc::new(JsxExecutionFs {
            inner: base,
            outputs,
        });
        options.host = new_cached_fs_compiler_host(
            &current_directory,
            overlay,
            &default_library_path,
            None,
            None,
            None,
        );
    }
    version(options)
}

/// Discover public contracts imported exclusively by JavaScript implementations.
/// Resolution still uses the project's exports/conditions, never sibling guessing.
pub fn contract_view(
    mut options: ProgramOptions,
    mut roots: Vec<String>,
) -> &'static source_frontend::core::GoProgram {
    options.use_source_of_project_reference = true;
    roots.extend(options.config.parsed_config.file_names.iter().cloned());
    roots.sort();
    roots.dedup();
    let mut config = options.config.with_file_names(roots);
    let compiler = Rc::make_mut(&mut config.parsed_config.compiler_options);
    compiler.no_dts_resolution = Tristate::False;
    compiler.allow_js = Tristate::True;
    compiler.check_js = Tristate::False;
    compiler.max_node_module_js_depth = Some(i64::MAX);
    options.config = Rc::new(config);
    version(options)
}

fn version(options: ProgramOptions) -> &'static source_frontend::core::GoProgram {
    let _parse_scope = source_frontend::core::enter_program(None);
    let native = Rc::new(source_frontend::frontend::compiler::new_program(options));
    program::new_program_version(&native, None)
}

fn is_declaration(path: &str) -> bool {
    [".d.ts", ".d.mts", ".d.cts"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
}

pub(crate) fn runtime_sibling(path: &str) -> Option<String> {
    [(".d.mts", ".mjs"), (".d.cts", ".cjs"), (".d.ts", ".js")]
        .into_iter()
        .find_map(|(declaration, runtime)| {
            path.strip_suffix(declaration)
                .map(|stem| format!("{stem}{runtime}"))
        })
}

fn package_parts(specifier: &str) -> Option<(String, String)> {
    if specifier.starts_with('.') || specifier.starts_with('/') || specifier.contains(':') {
        return None;
    }
    let mut parts = specifier.split('/');
    let first = parts.next()?;
    let (name, rest) = if first.starts_with('@') {
        let second = parts.next()?;
        (format!("{first}/{second}"), parts.collect::<Vec<_>>())
    } else {
        (first.to_string(), parts.collect::<Vec<_>>())
    };
    Some((name, rest.join("/")))
}

fn manifest_name(root: &Path) -> Option<String> {
    let bytes = std::fs::read(root.join("package.json")).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()?
        .get("name")?
        .as_str()
        .map(str::to_string)
}

fn package_root(importer: &str, declaration: &str, package: &str) -> Option<PathBuf> {
    // First prefer the package that owns the declaration, except for an
    // external `@types/*` contract whose runtime is a different package.
    for ancestor in Path::new(declaration).ancestors() {
        if ancestor.join("package.json").is_file()
            && manifest_name(ancestor).as_deref() == Some(package)
        {
            return Some(ancestor.to_path_buf());
        }
    }
    // Node's lookup walks parent directories. This also follows Bun's
    // node_modules symlinks without depending on the layout of its store.
    for ancestor in Path::new(importer).parent()?.ancestors() {
        let candidate = ancestor.join("node_modules").join(package);
        if candidate.join("package.json").is_file() {
            return std::fs::canonicalize(&candidate).ok().or(Some(candidate));
        }
    }
    None
}

fn export_target(value: &serde_json::Value, wildcard: Option<&str>) -> Option<String> {
    match value {
        serde_json::Value::String(path) => Some(match wildcard {
            Some(value) => path.replace('*', value),
            None => path.clone(),
        }),
        serde_json::Value::Array(values) => values
            .iter()
            .find_map(|value| export_target(value, wildcard)),
        serde_json::Value::Object(map) => {
            // Match the execution view's Node/ESM conditions and explicitly
            // skip declaration-only branches.
            for condition in ["node", "import", "module", "bun", "default"] {
                if let Some(value) = map.get(condition)
                    && let Some(path) = export_target(value, wildcard)
                {
                    return Some(path);
                }
            }
            map.iter()
                .filter(|(condition, _)| condition.as_str() != "types")
                .find_map(|(_, value)| export_target(value, wildcard))
        }
        _ => None,
    }
}

fn manifest_runtime(root: &Path, subpath: &str) -> Option<PathBuf> {
    let bytes = std::fs::read(root.join("package.json")).ok()?;
    let manifest = serde_json::from_slice::<serde_json::Value>(&bytes).ok()?;
    let target = if let Some(exports) = manifest.get("exports") {
        let key = if subpath.is_empty() {
            ".".to_string()
        } else {
            format!("./{subpath}")
        };
        match exports {
            serde_json::Value::Object(map) if map.keys().any(|key| key.starts_with('.')) => {
                if let Some(value) = map.get(&key) {
                    export_target(value, None)
                } else {
                    map.iter().find_map(|(pattern, value)| {
                        let (prefix, suffix) = pattern.split_once('*')?;
                        let wildcard = key.strip_prefix(prefix)?.strip_suffix(suffix)?;
                        export_target(value, Some(wildcard))
                    })
                }
            }
            _ if subpath.is_empty() => export_target(exports, None),
            _ => None,
        }
    } else if subpath.is_empty() {
        manifest
            .get("module")
            .and_then(serde_json::Value::as_str)
            .or_else(|| manifest.get("main").and_then(serde_json::Value::as_str))
            .map_or_else(
                || Some("index.js".to_string()),
                |path| Some(path.to_string()),
            )
    } else {
        Some(subpath.to_string())
    }?;
    let path = root.join(target.trim_start_matches("./"));
    path.is_file().then_some(path)
}

pub(crate) fn resolve_runtime_module(
    importer: &str,
    specifier: &str,
    declaration: &str,
) -> Option<String> {
    if !declaration.is_empty() && !is_declaration(declaration) && Path::new(declaration).is_file() {
        let runtime =
            std::fs::canonicalize(declaration).unwrap_or_else(|_| PathBuf::from(declaration));
        return Some(path_for_frontend(&runtime));
    }
    if let Some(sibling) = runtime_sibling(declaration)
        && Path::new(&sibling).is_file()
    {
        return Some(sibling);
    }
    if specifier.starts_with('.') {
        let runtime = Path::new(importer).parent()?.join(specifier);
        if runtime.is_file() {
            let runtime = std::fs::canonicalize(&runtime).unwrap_or(runtime);
            return Some(path_for_frontend(&runtime));
        }
    }
    let (package, subpath) = package_parts(specifier)?;
    let root = package_root(importer, declaration, &package)?;
    let runtime = manifest_runtime(&root, &subpath)?;
    let runtime = std::fs::canonicalize(&runtime).unwrap_or(runtime);
    Some(path_for_frontend(&runtime))
}
