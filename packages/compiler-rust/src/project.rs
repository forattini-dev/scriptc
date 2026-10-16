//! Project loading uses the pinned Rust tsconfig parser and filesystem host.
use goport_core::{
    frontend::{
        bundled,
        compiler::{ProgramOptions, new_cached_fs_compiler_host},
        tsoptions::{ParseConfigHost, get_parsed_command_line_of_config_file},
        vfs::{Fs, osvfs_fs},
    },
    options::{CompilerOptions, Tristate},
    program,
};
use std::{
    path::{Path, PathBuf},
    rc::Rc,
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

pub fn load(input: &Path, work: &Path, project: Option<&Path>) -> Result<(), String> {
    let source = path_for_frontend(input);
    let config_path = if let Some(project) = project {
        project.to_path_buf()
    } else {
        let prelude = work.join("native-console.d.ts");
        // Compatible with global Console declarations brought in by type references.
        std::fs::write(&prelude, "interface Console { log(...values: unknown[]): void; error(...values: unknown[]): void; }\ndeclare var console: Console;\n").map_err(|e| e.to_string())?;
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
    let cwd = path_for_frontend(&std::env::current_dir().map_err(|e| e.to_string())?);
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
                    d.localize(&goport_core::locale::DEFAULT)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let config =
        config.ok_or_else(|| "SCN0001: project configuration could not be loaded".to_string())?;
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
    let host = new_cached_fs_compiler_host(&cwd, fs, &bundled::lib_path(), None, None, None);
    program::install_new_program(ProgramOptions {
        host,
        config: Rc::new(config),
        use_source_of_project_reference: false,
        single_threaded: Tristate::True,
        typings_location: String::new(),
        project_name: String::new(),
        create_module_resolver: None,
        skip_module_resolution: false,
    })?;
    Ok(())
}

fn is_declaration(path: &str) -> bool {
    [".d.ts", ".d.mts", ".d.cts"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
}
