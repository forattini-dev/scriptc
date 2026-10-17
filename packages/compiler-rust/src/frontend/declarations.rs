//! Portable contracts between the checked declaration graph and JS execution
//! graph. No checker IDs or AST nodes survive the program-version boundary.
use super::*;
use source_frontend::prelude::{SignatureKind, SymbolId, get_source_file_of_node};

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
pub(super) struct ClassHint {
    pub params: Vec<Option<Type>>,
    pub fields: Vec<(String, Option<Type>)>,
    pub methods: Vec<(String, Option<Type>)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Hint {
    pub params: Vec<Option<Type>>,
    pub ret: Option<Type>,
    pub reason: Option<String>,
    pub value_type: Option<Type>,
    pub class: Option<ClassHint>,
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
    callables: HashMap<usize, Type>,
    projections: HashMap<Key, Type>,
    literal_choices: HashMap<Key, Type>,
}
pub(super) struct Linked {
    pub hints: HashMap<Key, Hint>,
    pub records: Vec<ir::Record>,
    pub unions: Vec<ir::Union>,
    pub callables: HashMap<usize, Type>,
    pub projections: HashMap<Key, Type>,
    pub literal_choices: HashMap<Key, Type>,
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
        for file in &files {
            let file = *file;
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
                let constructors = lowerer
                    .checker
                    .get_signatures_of_type(ty, SignatureKind::CONSTRUCT);
                let mut hint = Hint {
                    params: vec![],
                    ret: None,
                    reason: None,
                    value_type: None,
                    class: None,
                };
                if constructors.len() == 1 {
                    let signature = constructors[0];
                    // A polymorphic declaration has one implementation ABI.
                    // Keep its payloads in owning native slots, just as for
                    // generic exported functions, rather than specializing
                    // the implementation to one consumer's type arguments.
                    let erased = !lowerer.checker.sig(signature).type_parameters.is_empty();
                    let parameters = lowerer.checker.sig(signature).parameters.clone();
                    let params = parameters
                        .into_iter()
                        .map(|p| {
                            if erased {
                                return Some(Type::Dyn);
                            }
                            let id = lowerer.checker.get_type_of_symbol(p);
                            lowerer.type_id(id)
                        })
                        .collect();
                    let instance = lowerer.checker.get_return_type_of_signature(signature);
                    let properties = lowerer.checker.get_properties_of_type(instance).to_vec();
                    let mut fields = Vec::new();
                    let mut methods = Vec::new();
                    for property in properties {
                        let info = lowerer.checker.sym(property);
                        let name = info.name.to_string();
                        if info.flags.intersects(SymbolFlags::METHOD) {
                            let id = lowerer.checker.get_type_of_symbol(property);
                            let signature = lowerer.function_type(id);
                            methods.push((name, signature));
                            continue;
                        }
                        if info.flags.intersects(SymbolFlags::ACCESSOR) {
                            continue;
                        }
                        let id = lowerer.checker.get_type_of_symbol(property);
                        fields.push((
                            name,
                            if erased {
                                Some(Type::Dyn)
                            } else {
                                lowerer.type_id(id)
                            },
                        ));
                    }
                    hint.class = Some(ClassHint {
                        params,
                        fields,
                        methods,
                    });
                } else if !signatures.is_empty() {
                    // Polymorphic public signatures use an owned native value ABI.
                    // This preserves payloads instead of choosing an arbitrary overload.
                    if signatures.len() != 1
                        || !lowerer
                            .checker
                            .sig(signatures[0])
                            .type_parameters
                            .is_empty()
                    {
                        hint.value_type = lowerer.type_id(ty);
                        hint.params = lowerer
                            .checker
                            .sig(signatures[0])
                            .parameters
                            .iter()
                            .map(|_| Some(Type::Dyn))
                            .collect();
                        hint.ret = Some(Type::Dyn);
                    } else {
                        // Use the same signature adapter as first-class calls:
                        // a fixed tuple rest is a finite list of ABI slots.
                        if let Some(Type::Func { params, ret }) = lowerer.function_type(ty) {
                            hint.params = params.into_iter().map(Some).collect();
                            hint.ret = Some(*ret);
                        } else {
                            hint.reason =
                                Some("public JavaScript signature has no fixed native ABI".into());
                        }
                        if hint.reason.is_none()
                            && !lowerer.checker.get_properties_of_type(ty).is_empty()
                        {
                            hint.value_type = lowerer.type_id(ty);
                            if hint.value_type.is_none() {
                                hint.reason = Some(
                                    "public callable properties have no native representation"
                                        .into(),
                                );
                            }
                        }
                    }
                } else {
                    continue;
                }
                exports.push(Export {
                    file: path.clone(),
                    name,
                    hint,
                });
            }
        }
        // Preserve checked member/call projections in source consumers. JS
        // implementation inference must not replace a public field with any,
        // or erase control-flow narrowing of an optional public member.
        fn portable(
            t: &Type,
            records: &[ir::Record],
            unions: &[ir::Union],
            seen: &mut HashSet<Type>,
        ) -> bool {
            if !seen.insert(t.clone()) {
                return true;
            }
            match t {
                Type::Object { .. } | Type::Classval { .. } => false,
                Type::Func { params, ret } => {
                    params.iter().all(|p| portable(p, records, unions, seen))
                        && portable(ret, records, unions, seen)
                }
                Type::Record { shape_id } => {
                    records[*shape_id]
                        .fields
                        .iter()
                        .all(|f| portable(&f.r#type, records, unions, seen))
                        && records[*shape_id]
                            .index_value
                            .as_ref()
                            .is_none_or(|t| portable(t, records, unions, seen))
                }
                Type::Union { union_id } => unions[*union_id]
                    .arms
                    .iter()
                    .all(|t| portable(t, records, unions, seen)),
                Type::Array { elem } | Type::Set { elem } => portable(elem, records, unions, seen),
                Type::Promise { inner } => portable(inner, records, unions, seen),
                Type::Map { key, value } => {
                    portable(key, records, unions, seen) && portable(value, records, unions, seen)
                }
                _ => true,
            }
        }
        fn project(lowerer: &mut Lowerer<'_>, node: Node, out: &mut HashMap<Key, Type>) {
            if node.kind() == SyntaxKind::ObjectLiteralExpression
                && let Some(choice) = lowerer.contextual_union_literal(node)
                && portable(
                    &choice,
                    &lowerer.records,
                    &lowerer.unions,
                    &mut HashSet::new(),
                )
            {
                lowerer.literal_choices.insert(Key::of(node), choice);
            }
            if matches!(
                node.kind(),
                SyntaxKind::Identifier
                    | SyntaxKind::PropertyAccessExpression
                    | SyntaxKind::ElementAccessExpression
                    | SyntaxKind::CallExpression
            ) {
                let id = lowerer.checker.get_type_at_location(node);
                if let Some(ty) = lowerer.type_id(id)
                    && portable(&ty, &lowerer.records, &lowerer.unions, &mut HashSet::new())
                {
                    out.insert(Key::of(node), ty);
                }
            }
            node.for_each_child(&mut |child| {
                project(lowerer, child, out);
                false
            });
        }
        let mut projections = HashMap::new();
        for file in files {
            let path = source_file_info(file).file_name.to_string();
            if !is_declaration(&path) && !is_javascript(&path) {
                project(&mut lowerer, file, &mut projections);
            }
        }
        Catalog {
            projections,
            literal_choices: lowerer.literal_choices,
            edges,
            exports,
            records: lowerer.records,
            unions: lowerer.unions,
            callables: lowerer.callables,
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
                        SyntaxKind::FunctionDeclaration
                            | SyntaxKind::VariableDeclaration
                            | SyntaxKind::ClassDeclaration
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
            projections: self.projections,
            literal_choices: self.literal_choices,
            hints,
            records: self.records,
            unions: self.unions,
            callables: self.callables,
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
    pub(super) fn class_contract(&self, node: Node) -> Option<&ClassHint> {
        let binding = if node.kind() == SyntaxKind::ClassExpression {
            node.parent()
        } else {
            node
        };
        self.declared(binding).and_then(|h| h.class.as_ref())
    }
    pub(super) fn checker_any(&mut self, node: Node) -> bool {
        if self.projections.contains_key(&Key::of(node)) {
            return false;
        }
        let id = self.checker.get_type_at_location(node);
        self.checker.ty(id).flags.intersects(TypeFlags::ANY)
    }
}
