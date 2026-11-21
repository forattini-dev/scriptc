//! Resolve executable modules before lowering. This phase never drops initializers.
use super::*;

fn executable_typescript_source(file: Node, path: &str) -> bool {
    if [".ts", ".mts", ".js", ".mjs", ".cjs"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
    {
        return true;
    }
    if !path.ends_with(".tsx") {
        return false;
    }
    fn contains_jsx(node: Node) -> bool {
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
    !contains_jsx(file)
}

pub(super) struct ModulePlan {
    pub modules: Vec<Node>,
    pub execution_order: Vec<Node>,
    pub bindings: Vec<ImportBinding>,
    pub requires: HashMap<declarations::Key, Node>,
    pub esm_requires: HashMap<declarations::Key, (Node, Node)>,
    pub dynamic_commonjs: HashMap<declarations::Key, Node>,
    pub missing_dynamic_imports: HashSet<declarations::Key>,
    pub missing_requires: HashMap<declarations::Key, Node>,
    /// Indices in this graph refer to `graph_files`, not execution order.
    pub graph: super::module_graph::ModuleGraph,
    pub graph_files: Vec<Node>,
    pub lazy_modules: Vec<Node>,
    pub planning_diagnostics: Vec<String>,
}

pub(super) fn caught_by_enclosing_try(mut node: Node) -> bool {
    while !node.is_nil() {
        let parent = node.parent();
        if parent.is_nil() {
            return false;
        }
        if parent.kind() == SyntaxKind::TryStatement {
            return node == parent.try_block() && !parent.catch_clause().is_nil();
        }
        if matches!(
            parent.kind(),
            SyntaxKind::FunctionDeclaration
                | SyntaxKind::FunctionExpression
                | SyntaxKind::ArrowFunction
                | SyntaxKind::SourceFile
        ) {
            return false;
        }
        node = parent;
    }
    false
}

/// An unobserved default expression still runs at its source position. Keep
/// the snapshot binding refused whenever any reachable import or re-export can
/// observe it, until default-export cells have their own module storage.
pub(super) fn unobserved_defaults(
    checker: &mut Checker,
    files: &[Node],
) -> HashSet<declarations::Key> {
    let mut defaults = HashMap::new();
    for file in files {
        for node in file.statements() {
            if node.kind() == SyntaxKind::ExportAssignment && !node.is_export_equals() {
                defaults.insert(source_file_info(*file).file_name.to_string(), node);
            }
        }
    }
    let mut observed = HashSet::new();
    for file in files {
        for node in file.statements() {
            let Some(specifier) = runtime_specifier(node) else {
                continue;
            };
            let symbol = checker.get_symbol_at_location(specifier, false);
            if symbol.0 == 0 {
                continue;
            }
            let target = checker.sym(symbol).value_declaration;
            if target.is_nil() || target.kind() != SyntaxKind::SourceFile {
                continue;
            }
            let path = source_file_info(target).file_name.to_string();
            if !defaults.contains_key(&path) {
                continue;
            }
            let observes = if node.kind() == SyntaxKind::ImportDeclaration {
                let clause = node.import_clause();
                if clause.is_nil() {
                    false
                } else {
                    let bindings = clause.named_bindings();
                    !clause.name().is_nil()
                        || (!bindings.is_nil()
                            && (bindings.kind() == SyntaxKind::NamespaceImport
                                || (bindings.kind() == SyntaxKind::NamedImports
                                    && bindings.elements().into_iter().any(|item| {
                                        !item.is_type_only()
                                            && item.property_name_or_name().text() == "default"
                                    }))))
                }
            } else {
                let clause = node.export_clause();
                !clause.is_nil()
                    && (clause.kind() != SyntaxKind::NamedExports
                        || clause.elements().into_iter().any(|item| {
                            !item.is_type_only() && item.property_name_or_name().text() == "default"
                        }))
            };
            if observes {
                observed.insert(path);
            }
        }
    }
    defaults
        .into_iter()
        .filter_map(|(path, node)| (!observed.contains(&path)).then(|| declarations::Key::of(node)))
        .collect()
}

pub(super) enum ImportBinding {
    Asset {
        node: Node,
        path: String,
        file: String,
        kind: AssetKind,
    },
    NativeRequire {
        call: Node,
        declaration: Node,
        module: &'static str,
    },
    CommonJs {
        node: Node,
        target: Node,
    },
    Native {
        node: Node,
        module: &'static str,
        file: String,
    },
    Json {
        node: Node,
        path: String,
        file: String,
    },
}

#[derive(Clone, Copy)]
pub(super) enum AssetKind {
    File,
    Text,
}

// A whole type-only declaration is erased. Inline type specifiers can leave
// an empty runtime import/export, so keep their module evaluation edge.
pub(crate) fn runtime_specifier(node: Node) -> Option<Node> {
    if !matches!(
        node.kind(),
        SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration
    ) || node.is_type_only()
    {
        return None;
    }
    if node.kind() == SyntaxKind::ImportDeclaration {
        let clause = node.import_clause();
        if !clause.is_nil() && clause.is_type_only() {
            return None;
        }
    }
    let specifier = node.module_specifier();
    (!specifier.is_nil()).then_some(specifier)
}

pub(crate) fn dynamic_imports(file: Node) -> Vec<(Node, Node)> {
    fn visit(node: Node, imports: &mut Vec<(Node, Node)>) {
        if node.kind() == SyntaxKind::CallExpression
            && node.expression().kind() == SyntaxKind::ImportKeyword
        {
            let args = node.arguments().into_iter().collect::<Vec<_>>();
            if let [specifier] = args.as_slice()
                && matches!(
                    specifier.kind(),
                    SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
                )
            {
                imports.push((node, *specifier));
            }
        }
        node.for_each_child(&mut |child| {
            visit(child, imports);
            false
        });
    }
    let mut imports = Vec::new();
    visit(file, &mut imports);
    imports
}

pub(super) fn resolved_dynamic_target(file: Node, specifier: Node) -> Node {
    let resolved = program::get_resolved_module_from_module_specifier(file, specifier);
    let target = resolved
        .as_ref()
        .map(program::get_source_file_for_resolved_module)
        .unwrap_or(Node::NIL);
    if !target.is_nil()
        && target.kind() == SyntaxKind::SourceFile
        && !is_declaration(&source_file_info(target).file_name)
    {
        return target;
    }
    let declaration = resolved
        .as_ref()
        .map(|resolved| resolved.resolved_file_name.as_str())
        .unwrap_or_default();
    crate::project::resolve_runtime_module(
        &source_file_info(file).file_name,
        specifier.text(),
        declaration,
    )
    .map(|runtime| program::get_source_file(&runtime))
    .filter(|runtime| !runtime.is_nil())
    .unwrap_or(target)
}

fn resolved_runtime_target(checker: &mut Checker, file: Node, specifier: Node) -> Node {
    // In packages that ship adjacent `index.js`/`index.d.ts`, the checker
    // symbol intentionally points at the declaration contract even though the
    // module resolver selected the JavaScript runtime export. Native lowering
    // needs that resolved source body; retain the symbol only as a fallback for
    // project sources whose resolver record is unavailable.
    if let Some(resolved) = program::get_resolved_module_from_module_specifier(file, specifier) {
        let target = program::get_source_file_for_resolved_module(&resolved);
        if !target.is_nil() && target.kind() == SyntaxKind::SourceFile {
            let path = source_file_info(target).file_name.to_string();
            if let Some(runtime) = crate::project::resolve_runtime_module(
                &source_file_info(file).file_name,
                specifier.text(),
                &path,
            ) {
                let executable = program::get_source_file(&runtime);
                if !executable.is_nil() && executable.kind() == SyntaxKind::SourceFile {
                    return executable;
                }
            }
            return target;
        }
    }
    let symbol = checker.get_symbol_at_location(specifier, false);
    if symbol.0 == 0 {
        Node::NIL
    } else {
        checker.sym(symbol).value_declaration
    }
}

// Function-only targets have no observable evaluation work. The restricted
// lazy initializer below also handles classes, lexical bindings and
// synchronous project dependencies. Exported mutable bindings and top-level
// await still need more work.
fn inert_dynamic_module(file: Node) -> bool {
    file.statements().into_iter().all(|statement| {
        matches!(
            statement.kind(),
            SyntaxKind::FunctionDeclaration
                | SyntaxKind::InterfaceDeclaration
                | SyntaxKind::TypeAliasDeclaration
                | SyntaxKind::EmptyStatement
        )
    })
}

fn simple_lazy_module(file: Node, dependency: bool) -> bool {
    module_graph::top_level_await_sites(file).is_empty()
        && file.statements().into_iter().all(|statement| {
            matches!(
                statement.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::ClassDeclaration
                    | SyntaxKind::EnumDeclaration
                    | SyntaxKind::InterfaceDeclaration
                    | SyntaxKind::TypeAliasDeclaration
                    | SyntaxKind::EmptyStatement
                    | SyntaxKind::ExpressionStatement
                    | SyntaxKind::ExportAssignment
            ) || statement.kind() == SyntaxKind::ImportDeclaration
                || (statement.kind() == SyntaxKind::ModuleDeclaration
                    && statement
                        .modifier_flags()
                        .intersects(ModifierFlags::AMBIENT))
                || (statement.kind() == SyntaxKind::ExportDeclaration
                    && (statement.is_type_only()
                        || dependency
                        || statement.export_clause().is_nil()
                        || (!statement.export_clause().is_nil()
                            && statement.export_clause().kind() == SyntaxKind::NamedExports)))
                || (statement.kind() == SyntaxKind::VariableStatement
                    && (dependency
                        || (statement
                            .declaration_list()
                            .flags()
                            .intersects(NodeFlags::LET | NodeFlags::CONST)
                            && (!statement
                                .declaration_list()
                                .flags()
                                .contains(NodeFlags::LET)
                                || !statement.modifier_flags().intersects(ModifierFlags::EXPORT))))
                    && statement
                        .declaration_list()
                        .declarations()
                        .nodes()
                        .iter()
                        .all(|declaration| {
                            declaration.name().kind() == SyntaxKind::Identifier
                                || !statement.modifier_flags().intersects(ModifierFlags::EXPORT)
                                || statement
                                    .declaration_list()
                                    .flags()
                                    .contains(NodeFlags::CONST)
                        }))
        })
}

fn asset_loader_import(node: Node) -> Option<AssetKind> {
    // Bun's built-in text loader is selected by extension even without an
    // import attribute.  Preserve the explicit attribute path below for
    // arbitrary extensions, while making ordinary `import x from "./x.txt"`
    // portable to the native backend.
    if node.module_specifier().text().ends_with(".txt") {
        return Some(AssetKind::Text);
    }
    let attributes = node.attributes();
    if attributes.is_nil() {
        return None;
    }
    attributes
        .attribute_list()
        .nodes()
        .iter()
        .find_map(|attribute| {
            let mut children = Vec::new();
            attribute.for_each_child(&mut |child| {
                children.push(child);
                false
            });
            match children.as_slice() {
                [name, value] if name.text() == "type" && value.text() == "file" => {
                    Some(AssetKind::File)
                }
                [name, value] if name.text() == "type" && value.text() == "text" => {
                    Some(AssetKind::Text)
                }
                _ => None,
            }
        })
}

impl ModulePlan {
    pub(super) fn source_modules(&self) -> Vec<ir::SourceModule> {
        let eager = self
            .execution_order
            .iter()
            .map(|file| source_file_info(*file).file_name.to_string())
            .collect::<HashSet<_>>();
        let mut modules = self
            .graph_files
            .iter()
            .enumerate()
            .map(|(index, file)| {
                let mut static_dependencies = self.graph.edges[index]
                    .iter()
                    .map(|dependency| {
                        source_file_info(self.graph_files[*dependency])
                            .file_name
                            .to_string()
                    })
                    .collect::<Vec<_>>();
                let mut dynamic_dependencies = self.graph.dynamic_edges[index]
                    .iter()
                    .map(|dependency| {
                        source_file_info(self.graph_files[*dependency])
                            .file_name
                            .to_string()
                    })
                    .collect::<Vec<_>>();
                static_dependencies.sort();
                dynamic_dependencies.sort();
                let file_name = source_file_info(*file).file_name.to_string();
                ir::SourceModule {
                    eager: eager.contains(&file_name),
                    file: file_name,
                    static_dependencies,
                    dynamic_dependencies,
                    source_bytes: source_file_text(*file).len(),
                }
            })
            .collect::<Vec<_>>();
        modules.sort_by(|left, right| left.file.cmp(&right.file));
        modules
    }

    pub(super) fn link(
        checker: &mut Checker,
        entry: Node,
        allow_unsupported_lazy: bool,
    ) -> Result<Self, String> {
        let mut plan = Self {
            modules: Vec::new(),
            execution_order: Vec::new(),
            bindings: Vec::new(),
            requires: HashMap::new(),
            esm_requires: HashMap::new(),
            dynamic_commonjs: HashMap::new(),
            missing_dynamic_imports: HashSet::new(),
            missing_requires: HashMap::new(),
            graph: super::module_graph::ModuleGraph::default(),
            graph_files: Vec::new(),
            lazy_modules: Vec::new(),
            planning_diagnostics: Vec::new(),
        };
        plan.visit(
            checker,
            entry,
            &mut HashSet::new(),
            &mut HashSet::new(),
            allow_unsupported_lazy,
        )?;
        let mut scheduled = HashMap::new();
        let root = plan.schedule(checker, entry, &mut scheduled);
        let esm_require_edges = plan.esm_requires.values().copied().collect::<Vec<_>>();
        for (call, target) in esm_require_edges {
            let owner = source_frontend::prelude::get_source_file_of_node(call);
            let owner = scheduled[&source_file_info(owner).file_name.to_string()];
            let dependency = plan.schedule(checker, target, &mut scheduled);
            plan.graph.add_dynamic_dependency(owner, dependency);
        }
        plan.execution_order = plan
            .graph
            .evaluation_order(root)
            .into_iter()
            .map(|index| plan.graph_files[index])
            .collect();
        let mut seen_targets = HashSet::new();
        let dynamic_targets = plan
            .graph
            .dynamic_edges
            .iter()
            .flatten()
            .copied()
            .filter(|target| seen_targets.insert(*target))
            .collect::<Vec<_>>();
        if dynamic_targets.is_empty() {
            return Ok(plan);
        }
        let mut lazy_indices = HashSet::new();
        for target in dynamic_targets {
            let dynamic_root = source_file_info(plan.graph_files[target]).file_name.clone();
            for index in plan.graph.evaluation_order(target) {
                let module = plan.graph_files[index];
                if plan.execution_order.contains(&module) || inert_dynamic_module(module) {
                    continue;
                }
                if commonjs::is_module(module) {
                    // CommonJS has its own cached initializer. A lazy ESM
                    // importer invokes it in dependency order below.
                    continue;
                }
                let path = source_file_info(module).file_name.to_string();
                let unsupported = !simple_lazy_module(module, index != target);
                if unsupported && !allow_unsupported_lazy {
                    let incoming = plan
                        .graph
                        .dynamic_edges
                        .iter()
                        .enumerate()
                        .filter(|(_, dependencies)| dependencies.contains(&index))
                        .map(|(owner, _)| {
                            source_file_info(plan.graph_files[owner]).file_name.clone()
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    let error = refusal(
                        &path,
                        module,
                        &format!(
                            "dynamic import target requires lazy native module evaluation for this dependency graph; lazy root: {dynamic_root}; dynamic owners: {incoming}"
                        ),
                    );
                    if allow_unsupported_lazy {
                        plan.planning_diagnostics.push(error);
                    } else {
                        return Err(error);
                    }
                }
                if lazy_indices.insert(index) {
                    plan.lazy_modules.push(module);
                }
            }
        }
        Ok(plan)
    }

    fn schedule(
        &mut self,
        checker: &mut Checker,
        file: Node,
        visited: &mut HashMap<String, usize>,
    ) -> usize {
        let path = source_file_info(file).file_name.to_string();
        if let Some(index) = visited.get(&path) {
            return *index;
        }
        let index = self.graph.add_module();
        self.graph_files.push(file);
        visited.insert(path, index);
        if !commonjs::is_module(file) {
            for node in file.statements() {
                let Some(specifier) = runtime_specifier(node) else {
                    continue;
                };
                if builtins::module(specifier.text()).is_some() || specifier.text().contains(':') {
                    continue;
                }
                let target = resolved_runtime_target(checker, file, specifier);
                if !target.is_nil() && target.kind() == SyntaxKind::SourceFile {
                    let dependency = self.schedule(checker, target, visited);
                    self.graph.add_dependency(index, dependency);
                }
            }
            for (_, specifier) in dynamic_imports(file) {
                if builtins::module(specifier.text()).is_some() || specifier.text().contains(':') {
                    continue;
                }
                let target = resolved_dynamic_target(file, specifier);
                if !target.is_nil() && target.kind() == SyntaxKind::SourceFile {
                    if commonjs::is_module(target) {
                        continue;
                    }
                    let dependency = self.schedule(checker, target, visited);
                    self.graph.add_dynamic_dependency(index, dependency);
                }
            }
        }
        index
    }

    fn visit(
        &mut self,
        checker: &mut Checker,
        file: Node,
        active: &mut HashSet<String>,
        visited: &mut HashSet<String>,
        allow_unsupported_lazy: bool,
    ) -> Result<(), String> {
        let path = source_file_info(file).file_name.to_string();
        if visited.contains(&path) || !active.insert(path.clone()) {
            return Ok(());
        }
        for node in file.statements() {
            let Some(specifier) = runtime_specifier(node) else {
                continue;
            };
            if let Some(module) = builtins::module(specifier.text()) {
                self.bindings.push(ImportBinding::Native {
                    node,
                    module,
                    file: path.clone(),
                });
                continue;
            }
            let target = resolved_runtime_target(checker, file, specifier);
            if target.is_nil() {
                let error = refusal(
                    &path,
                    node,
                    &format!(
                        "Rust frontend did not resolve runtime module '{}'",
                        specifier.text()
                    ),
                );
                if allow_unsupported_lazy {
                    self.planning_diagnostics.push(error);
                    continue;
                }
                return Err(error);
            }
            if let Some(kind) = asset_loader_import(node) {
                let source = std::path::Path::new(&path);
                let declaration =
                    program::get_resolved_module_from_module_specifier(file, specifier)
                        .map(|resolved| resolved.resolved_file_name)
                        .unwrap_or_default();
                let candidate =
                    crate::project::resolve_runtime_module(&path, specifier.text(), &declaration)
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|| {
                            source
                                .parent()
                                .unwrap_or_else(|| std::path::Path::new(""))
                                .join(specifier.text())
                        });
                let asset = match candidate.canonicalize() {
                    Ok(asset) => asset,
                    Err(cause) => {
                        let error =
                            refusal(&path, node, &format!("file asset was not found: {cause}"));
                        if allow_unsupported_lazy {
                            self.planning_diagnostics.push(error);
                            continue;
                        }
                        return Err(error);
                    }
                };
                self.bindings.push(ImportBinding::Asset {
                    node,
                    path: asset.to_string_lossy().into_owned(),
                    file: path.clone(),
                    kind,
                });
                continue;
            }
            if target.is_nil() || target.kind() != SyntaxKind::SourceFile {
                let error = refusal(
                    &path,
                    node,
                    &format!(
                        "import '{}' has no executable source module",
                        specifier.text()
                    ),
                );
                if allow_unsupported_lazy {
                    self.planning_diagnostics.push(error);
                    continue;
                }
                return Err(error);
            }
            let target_path = source_file_info(target).file_name.to_string();
            if target_path.ends_with(".json") {
                self.bindings.push(ImportBinding::Json {
                    node,
                    path: target_path,
                    file: path.clone(),
                });
                continue;
            }
            if is_declaration(&target_path) || !executable_typescript_source(target, &target_path) {
                let error = refusal(
                    &path,
                    node,
                    &format!(
                        "import '{}' resolves to unsupported runtime source '{target_path}'",
                        specifier.text()
                    ),
                );
                if allow_unsupported_lazy {
                    self.planning_diagnostics.push(error);
                    continue;
                }
                return Err(error);
            }
            if commonjs::is_module(target) {
                // Imports and static re-exports both observe the same cached
                // module.exports object. The binding phase maps named and
                // star-forwarded symbols onto that shared CommonJS instance.
                self.bindings.push(ImportBinding::CommonJs { node, target });
            }
            self.visit(checker, target, active, visited, allow_unsupported_lazy)?;
        }
        for (call, specifier) in dynamic_imports(file) {
            if builtins::module(specifier.text()).is_some() || specifier.text().contains(':') {
                continue;
            }
            let target = resolved_dynamic_target(file, specifier);
            let target_path = (!target.is_nil())
                .then(|| source_file_info(target).file_name.to_string())
                .unwrap_or_default();
            if !target.is_nil()
                && target.kind() == SyntaxKind::SourceFile
                && commonjs::is_module(target)
            {
                self.dynamic_commonjs
                    .insert(declarations::Key::of(call), target);
                self.visit(checker, target, active, visited, allow_unsupported_lazy)?;
                continue;
            }
            if target.is_nil() && caught_by_enclosing_try(call) {
                // Optional dependencies deliberately use a rejected import()
                // promise as their feature test. Preserve that rejection in
                // native code instead of demanding an absent package body.
                self.missing_dynamic_imports
                    .insert(declarations::Key::of(call));
                continue;
            }
            if target.is_nil()
                || target.kind() != SyntaxKind::SourceFile
                || is_declaration(&target_path)
                || !executable_typescript_source(target, &target_path)
            {
                let error = refusal(
                    &path,
                    call,
                    &format!(
                        "dynamic import '{}' requires an executable ESM source module; target='{}' commonjs={}",
                        specifier.text(),
                        if target_path.is_empty() {
                            "<none>"
                        } else {
                            &target_path
                        },
                        !target.is_nil()
                            && target.kind() == SyntaxKind::SourceFile
                            && commonjs::is_module(target),
                    ),
                );
                if allow_unsupported_lazy {
                    self.planning_diagnostics.push(error);
                    continue;
                }
                return Err(error);
            }
            if !allow_unsupported_lazy
                && !inert_dynamic_module(target)
                && !simple_lazy_module(target, false)
            {
                return Err(refusal(
                    &path,
                    call,
                    "dynamic import target requires lazy native module evaluation",
                ));
            }
            self.visit(checker, target, active, visited, allow_unsupported_lazy)?;
        }
        let mut calls = Vec::new();
        self.planning_diagnostics.extend(commonjs::require_calls(
            checker,
            file,
            &mut calls,
            allow_unsupported_lazy,
        )?);
        for (call, specifier) in calls {
            if !matches!(
                specifier.kind(),
                SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
            ) {
                self.missing_requires
                    .insert(declarations::Key::of(call), specifier);
                continue;
            }
            if let Some(module) = builtins::module(specifier.text()) {
                let mut owner = call.parent();
                while owner.kind() == SyntaxKind::ParenthesizedExpression {
                    owner = owner.parent();
                }
                if owner.kind() == SyntaxKind::CallExpression
                    && owner.expression().kind() == SyntaxKind::Identifier
                    && owner.expression().text() == "__importDefault"
                    && owner.arguments().len() == 1
                    && owner.arguments().get(0) == call
                {
                    owner = owner.parent();
                    while owner.kind() == SyntaxKind::ParenthesizedExpression {
                        owner = owner.parent();
                    }
                }
                let declaration = if owner.kind() == SyntaxKind::VariableDeclaration {
                    owner
                } else {
                    Node::NIL
                };
                self.bindings.push(ImportBinding::NativeRequire {
                    call,
                    declaration,
                    module,
                });
                continue;
            }
            // Assignment RHS requests need not have a declaration symbol at
            // their string literal. Use the program's resolved module graph.
            let resolved = program::get_resolved_module_from_module_specifier(file, specifier);
            let mut target = resolved
                .as_ref()
                .map(program::get_source_file_for_resolved_module)
                .unwrap_or(Node::NIL);
            if target.is_nil() {
                let symbol = checker.get_symbol_at_location(specifier, false);
                if symbol.0 != 0 {
                    target = checker.sym(symbol).value_declaration;
                }
            }
            if target.is_nil() {
                // TypeScript does not record an ESM `require()` call as a
                // module-resolution site. A colocated type-only import still
                // names the authoritative package export and, in the
                // execution view, resolves to its JavaScript implementation.
                if let Some(import_specifier) =
                    file.statements().into_iter().find_map(|statement| {
                        matches!(
                            statement.kind(),
                            SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration
                        )
                        .then(|| statement.module_specifier())
                        .filter(|candidate| {
                            !candidate.is_nil() && candidate.text() == specifier.text()
                        })
                    })
                    && let Some(import_resolution) =
                        program::get_resolved_module_from_module_specifier(file, import_specifier)
                {
                    target = program::get_source_file_for_resolved_module(&import_resolution);
                }
            }
            if target.is_nil() && specifier.text().starts_with('.') {
                let candidate = std::path::Path::new(&path)
                    .parent()
                    .unwrap_or_else(|| std::path::Path::new(""))
                    .join(specifier.text());
                if let Ok(candidate) = candidate.canonicalize() {
                    target = program::get_source_file(&path_for_frontend(&candidate));
                }
            }
            let target_path = (!target.is_nil())
                .then(|| source_file_info(target).file_name.to_string())
                .unwrap_or_default();
            if !target.is_nil()
                && target.kind() == SyntaxKind::SourceFile
                && !is_declaration(&target_path)
                && !commonjs::is_module(target)
                && executable_typescript_source(target, &target_path)
            {
                if !allow_unsupported_lazy
                    && !inert_dynamic_module(target)
                    && !simple_lazy_module(target, false)
                {
                    return Err(refusal(
                        &path,
                        call,
                        "synchronous ESM require target requires lazy native module evaluation",
                    ));
                }
                self.esm_requires
                    .insert(declarations::Key::of(call), (call, target));
                self.visit(checker, target, active, visited, allow_unsupported_lazy)?;
                continue;
            }
            if target.is_nil() {
                // Node resolves an absent optional dependency at the call
                // site, where surrounding try/catch can observe
                // MODULE_NOT_FOUND. Keep that behavior in the native IR
                // instead of rejecting the whole graph during planning.
                self.missing_requires
                    .insert(declarations::Key::of(call), specifier);
                continue;
            }
            if target.kind() != SyntaxKind::SourceFile
                || (!source_file_info(target).file_name.ends_with(".json")
                    && !commonjs::is_module(target))
            {
                let error = refusal(
                    &path,
                    call,
                    &resolved.as_ref().map_or_else(
                        || format!(
                            "require currently needs a resolved source CommonJS module; checker target={}",
                            if target.is_nil() {
                                "<none>".into()
                            } else {
                                source_file_info(target).file_name.to_string()
                            }
                        ),
                        |resolved| format!(
                            "require currently needs a source CommonJS module; resolved={} original={} alternate={} extension={}",
                            resolved.resolved_file_name,
                            resolved.original_path,
                            resolved.alternate_result,
                            resolved.extension,
                        ),
                    ),
                );
                if allow_unsupported_lazy {
                    self.planning_diagnostics.push(error);
                    continue;
                }
                return Err(error);
            }
            self.requires.insert(declarations::Key::of(call), target);
            if !source_file_info(target).file_name.ends_with(".json") {
                self.visit(checker, target, active, visited, allow_unsupported_lazy)?;
            }
        }
        active.remove(&path);
        visited.insert(path);
        self.modules.push(file);
        Ok(())
    }
}
