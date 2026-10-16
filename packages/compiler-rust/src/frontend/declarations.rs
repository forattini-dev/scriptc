//! Portable contracts between the checked declaration graph and JS execution
//! graph. No checker IDs or AST nodes survive the program-version boundary.
use super::*;
use goport_core::prelude::{SignatureKind, SymbolId, get_source_file_of_node};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Key {
    file: String,
    start: i32,
    end: i32,
}

impl Key {
    pub(super) fn of(node: Node) -> Self {
        Self {
            file: source_file_info(get_source_file_of_node(node))
                .file_name
                .to_string(),
            start: node.pos(),
            end: node.end(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Hint {
    pub params: Vec<Option<Type>>,
    pub ret: Option<Type>,
    pub reason: Option<String>,
}

impl Hint {
    pub(super) fn function_type(&self) -> Option<Type> {
        if self.reason.is_some() {
            return None;
        }
        Some(Type::Func {
            params: self.params.iter().cloned().collect::<Option<Vec<_>>>()?,
            ret: Box::new(self.ret.clone()?),
        })
    }
}

struct Edge {
    importer: String,
    specifier: String,
    target: String,
}
struct Export {
    file: String,
    name: String,
    hint: Hint,
}
pub(super) struct Catalog {
    edges: Vec<Edge>,
    exports: Vec<Export>,
    records: Vec<ir::Record>,
    unions: Vec<ir::Union>,
}
pub(super) struct Linked {
    pub hints: HashMap<Key, Hint>,
    pub records: Vec<ir::Record>,
    pub unions: Vec<ir::Union>,
}

fn unalias(checker: &mut Checker, symbol: SymbolId) -> SymbolId {
    if symbol.0 != 0 && checker.sym(symbol).flags.intersects(SymbolFlags::ALIAS) {
        checker.get_aliased_symbol(symbol)
    } else {
        symbol
    }
}

fn edges(checker: &mut Checker, files: &[Node]) -> Vec<Edge> {
    let mut edges = Vec::new();
    for file in files {
        for node in file.statements() {
            let Some(specifier) = modules::runtime_specifier(node) else {
                continue;
            };
            if builtins::module(specifier.text()).is_some() {
                continue;
            }
            let symbol = checker.get_symbol_at_location(specifier, false);
            let symbol = unalias(checker, symbol);
            if symbol.0 == 0 {
                continue;
            }
            let target = checker.sym(symbol).value_declaration;
            if target.is_nil() || target.kind() != SyntaxKind::SourceFile {
                continue;
            }
            edges.push(Edge {
                importer: source_file_info(*file).file_name.to_string(),
                specifier: specifier.text().to_string(),
                target: source_file_info(target).file_name.to_string(),
            });
        }
    }
    edges
}

pub(super) fn snapshot(source: &str) -> Result<Catalog, String> {
    let files = program::source_files();
    let entry = files
        .iter()
        .copied()
        .find(|f| source_file_info(*f).file_name == source)
        .ok_or("SCN0002: missing checked entry")?;
    let source = source.to_string();
    Ok(program::with_type_checker_for_file(entry, move |checker| {
        let edges = edges(checker, &files);
        // Follow actual non-builtin imports/reexports. Bundled/global type
        // libraries aren't runtime modules and must not seed contract tables.
        let mut reachable = files
            .iter()
            .filter_map(|f| {
                let name = source_file_info(*f).file_name.to_string();
                (!is_declaration(&name)).then_some(name)
            })
            .collect::<HashSet<_>>();
        loop {
            let mut changed = false;
            for edge in &edges {
                if reachable.contains(&edge.importer) {
                    changed |= reachable.insert(edge.target.clone());
                }
            }
            if !changed {
                break;
            }
        }
        let mut lowerer = Lowerer::new(checker, source);
        let mut exports = Vec::new();
        for file in files {
            let path = source_file_info(file).file_name.to_string();
            if !is_declaration(&path) || !reachable.contains(&path) || file.symbol().0 == 0 {
                continue;
            }
            for exported in lowerer
                .checker
                .get_exports_of_module_as_array(file.symbol())
            {
                let name = lowerer.checker.sym(exported).name.to_string();
                let symbol = unalias(lowerer.checker, exported);
                if symbol.0 == 0 {
                    continue;
                }
                let ty = lowerer.checker.get_type_of_symbol(symbol);
                let signatures = lowerer
                    .checker
                    .get_signatures_of_type(ty, SignatureKind::CALL);
                if signatures.is_empty() {
                    continue;
                }
                let mut hint = Hint {
                    params: Vec::new(),
                    ret: None,
                    reason: None,
                };
                if signatures.len() != 1 {
                    hint.reason =
                        Some("overloaded public JavaScript contracts are not ported".into());
                } else {
                    let signature = signatures[0];
                    let sig = lowerer.checker.sig(signature);
                    let parameters = sig.parameters.clone();
                    if !sig.type_parameters.is_empty()
                        || sig.this_parameter.0 != 0
                        || sig.has_rest_parameter()
                    {
                        hint.reason = Some(
                            "generic/receiver/rest public JavaScript contracts are not ported"
                                .into(),
                        );
                    }
                    for parameter in parameters {
                        let id = lowerer.checker.get_type_of_symbol(parameter);
                        hint.params.push(
                            lowerer.type_id(id).filter(|ty| {
                                !matches!(ty, Type::Null | Type::Undefined | Type::Void)
                            }),
                        );
                    }
                    let id = lowerer.checker.get_return_type_of_signature(signature);
                    hint.ret = if lowerer.checker.ty(id).flags.intersects(TypeFlags::VOID) {
                        Some(Type::Void)
                    } else {
                        lowerer
                            .type_id(id)
                            .filter(|ty| !matches!(ty, Type::Null | Type::Undefined))
                    };
                }
                exports.push(Export {
                    file: path.clone(),
                    name,
                    hint,
                });
            }
        }
        Catalog {
            edges,
            exports,
            records: lowerer.records,
            unions: lowerer.unions,
        }
    }))
}

impl Catalog {
    pub(super) fn link(self, checker: &mut Checker) -> Linked {
        let files = program::source_files();
        let execution_edges = edges(checker, &files);
        let checked_files = self
            .edges
            .iter()
            .flat_map(|e| [&e.importer, &e.target])
            .collect::<HashSet<_>>();
        let mut pairs = files
            .iter()
            .filter_map(|f| {
                let name = source_file_info(*f).file_name.to_string();
                checked_files
                    .contains(&name)
                    .then_some((name.clone(), name))
            })
            .collect::<HashSet<_>>();
        // Resolve identical specifiers in corresponding importer modules.
        // This also handles package exports that put types and JS in wholly
        // different directories, without probing/guessing sibling filenames.
        loop {
            let mut additions = Vec::new();
            for (checked, runtime) in &pairs {
                for edge in self.edges.iter().filter(|e| e.importer == *checked) {
                    for target in execution_edges
                        .iter()
                        .filter(|e| e.importer == *runtime && e.specifier == edge.specifier)
                    {
                        additions.push((edge.target.clone(), target.target.clone()));
                    }
                }
            }
            let mut changed = false;
            for pair in additions {
                changed |= pairs.insert(pair);
            }
            if !changed {
                break;
            }
        }
        let mut targets = HashMap::new();
        for file in files {
            let path = source_file_info(file).file_name.to_string();
            if !is_javascript(&path) || file.symbol().0 == 0 {
                continue;
            }
            for exported in checker.get_exports_of_module_as_array(file.symbol()) {
                let name = checker.sym(exported).name.to_string();
                let symbol = unalias(checker, exported);
                if symbol.0 == 0 {
                    continue;
                }
                let node = checker.sym(symbol).value_declaration;
                if !node.is_nil()
                    && matches!(
                        node.kind(),
                        SyntaxKind::FunctionDeclaration | SyntaxKind::VariableDeclaration
                    )
                {
                    targets.insert((path.clone(), name), Key::of(node));
                }
            }
        }
        let mut hints = HashMap::<Key, Hint>::new();
        for export in self.exports {
            for (_, runtime) in pairs.iter().filter(|(checked, _)| *checked == export.file) {
                if let Some(key) = targets.get(&(runtime.clone(), export.name.clone())) {
                    if let Some(previous) = hints.get_mut(key) {
                        if *previous != export.hint {
                            previous.reason = Some(
                                "conflicting public JavaScript contracts are not ported".into(),
                            );
                        }
                    } else {
                        hints.insert(key.clone(), export.hint.clone());
                    }
                }
            }
        }
        Linked {
            hints,
            records: self.records,
            unions: self.unions,
        }
    }
}

fn is_javascript(path: &str) -> bool {
    path.ends_with(".js") || path.ends_with(".mjs")
}

impl Lowerer<'_> {
    pub(super) fn declared(&self, node: Node) -> Option<&Hint> {
        self.declarations.get(&Key::of(node))
    }
    pub(super) fn checker_any(&mut self, node: Node) -> bool {
        let id = self.checker.get_type_at_location(node);
        self.checker.ty(id).flags.intersects(TypeFlags::ANY)
    }
}
