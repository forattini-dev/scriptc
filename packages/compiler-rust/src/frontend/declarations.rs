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
    pub constructor_declared: bool,
    pub params: Vec<Option<Type>>,
    pub fields: Vec<(String, Option<Type>)>,
    pub methods: Vec<(String, Option<Type>)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Hint {
    pub rest: bool,
    pub params: Vec<Option<Type>>,
    pub optional: Vec<bool>,
    pub parametric_callback_results: Vec<bool>,
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
            rest: self.rest,
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
pub(super) struct MemberDemands {
    edges: Vec<Edge>,
    files: Vec<String>,
    exports: HashMap<String, HashSet<String>>,
    objects: HashMap<(String, String), HashSet<String>>,
}
struct Export {
    file: String,
    name: String,
    hint: Hint,
}
struct MemberExport {
    file: String,
    name: String,
    member: String,
    signature: Type,
}
pub(super) struct Catalog {
    edges: Vec<Edge>,
    exports: Vec<Export>,
    members: Vec<MemberExport>,
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
    pub namespace_aliases: HashMap<String, String>,
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

// Discover only source-owned direct object methods while the execution graph
// is current. Paths and export/member names survive the checker version change;
// nodes, symbols and checker type IDs never cross it.
pub(super) fn member_demands(source: &str) -> Result<MemberDemands, String> {
    let files = program::source_files();
    let entry = files
        .iter()
        .copied()
        .find(|file| source_file_info(*file).file_name == source)
        .ok_or("SCN0002: missing execution entry for object method contracts")?;
    Ok(program::with_type_checker_for_file(entry, move |checker| {
        let mut objects = HashMap::new();
        let mut exports = HashMap::<String, HashSet<String>>::new();
        for file in &files {
            let path = source_file_info(*file).file_name.to_string();
            if !is_javascript(&path) || file.symbol().0 == 0 {
                continue;
            }
            for exported in checker.get_exports_of_module_as_array(file.symbol()) {
                let name = checker.sym(exported).name.to_string();
                exports
                    .entry(path.clone())
                    .or_default()
                    .insert(name.clone());
                let symbol = unalias(checker, exported);
                if symbol.0 == 0 {
                    continue;
                }
                let declaration = checker.sym(symbol).value_declaration;
                if declaration.is_nil()
                    || declaration.kind() != SyntaxKind::VariableDeclaration
                    || declaration.initializer().is_nil()
                {
                    continue;
                }
                let object = receivers::reference_node(declaration.initializer());
                if object.kind() != SyntaxKind::ObjectLiteralExpression
                    || object
                        .properties()
                        .into_iter()
                        .any(|p| p.kind() == SyntaxKind::SpreadAssignment)
                {
                    continue;
                }
                let mut methods = HashSet::new();
                let mut counts: HashMap<String, usize> = HashMap::new();
                for property in object.properties() {
                    if matches!(
                        property.kind(),
                        SyntaxKind::MethodDeclaration | SyntaxKind::PropertyAssignment
                    ) && matches!(
                        property.name().kind(),
                        SyntaxKind::Identifier | SyntaxKind::StringLiteral
                    ) {
                        *counts
                            .entry(property.name().text().to_string())
                            .or_default() += 1;
                    }
                }
                for property in object.properties() {
                    if !matches!(
                        property.kind(),
                        SyntaxKind::MethodDeclaration | SyntaxKind::PropertyAssignment
                    ) || !matches!(
                        property.name().kind(),
                        SyntaxKind::Identifier | SyntaxKind::StringLiteral
                    ) {
                        continue;
                    }
                    let member = property.name().text().to_string();
                    if counts.get(&member) != Some(&1) {
                        continue;
                    }
                    let function = if property.kind() == SyntaxKind::MethodDeclaration {
                        property
                    } else {
                        receivers::reference_node(property.initializer())
                    };
                    if matches!(
                        function.kind(),
                        SyntaxKind::MethodDeclaration
                            | SyntaxKind::ArrowFunction
                            | SyntaxKind::FunctionExpression
                    ) {
                        methods.insert(member);
                    }
                }
                if !methods.is_empty() {
                    objects.insert((path.clone(), name), methods);
                }
            }
        }
        MemberDemands {
            edges: edges(checker, &files),
            files: files
                .iter()
                .map(|f| source_file_info(*f).file_name.to_string())
                .collect(),
            exports,
            objects,
        }
    }))
}

fn paired_paths(
    checked: &[Edge],
    execution: &[Edge],
    files: &[String],
) -> HashSet<(String, String)> {
    let checked_files = checked
        .iter()
        .flat_map(|edge| [&edge.importer, &edge.target])
        .collect::<HashSet<_>>();
    let mut pairs = files
        .iter()
        .filter_map(|name| {
            checked_files
                .contains(name)
                .then_some((name.clone(), name.clone()))
        })
        .collect::<HashSet<_>>();
    let mut checked_by_file: HashMap<&str, Vec<&Edge>> = HashMap::new();
    for edge in checked {
        checked_by_file
            .entry(&edge.importer)
            .or_default()
            .push(edge);
    }
    let mut runtime_by_import: HashMap<(&str, &str), Vec<&str>> = HashMap::new();
    for edge in execution {
        runtime_by_import
            .entry((&edge.importer, &edge.specifier))
            .or_default()
            .push(&edge.target);
    }
    let mut pending = pairs.iter().cloned().collect::<Vec<_>>();
    while let Some((checked_file, runtime)) = pending.pop() {
        for edge in checked_by_file
            .get(checked_file.as_str())
            .into_iter()
            .flatten()
        {
            if let Some(targets) =
                runtime_by_import.get(&(runtime.as_str(), edge.specifier.as_str()))
            {
                for target in targets {
                    let pair = (edge.target.clone(), (*target).to_string());
                    if pairs.insert(pair.clone()) {
                        pending.push(pair);
                    }
                }
            }
        }
    }
    pairs
}

pub(super) fn snapshot(
    source: &str,
    console_prelude: Option<String>,
    demands: MemberDemands,
) -> Result<Catalog, String> {
    let files = program::source_files();
    let entry = files
        .iter()
        .copied()
        .find(|f| source_file_info(*f).file_name == source)
        .ok_or("SCN0002: missing checked entry")?;
    let source = source.to_string();
    Ok(program::with_type_checker_for_file(entry, move |checker| {
        let edges = edges(checker, &files);
        let pairs = paired_paths(&edges, &demands.edges, &demands.files);
        let mut projection_paths = pairs
            .iter()
            .map(|(checked, _)| checked.clone())
            .collect::<HashSet<_>>();
        projection_paths.insert(source.clone());
        let contract_paths = pairs
            .iter()
            .map(|(checked, _)| checked.clone())
            .filter(|checked| is_declaration(checked))
            .collect::<HashSet<_>>();
        if std::env::var("SCRIPTC_TRACE_PHASES").is_ok_and(|value| value == "1") {
            eprintln!(
                "scriptc: declaration catalog graph: {} files, {} pairs, {} runtime projections, {} declaration contracts",
                files.len(),
                pairs.len(),
                projection_paths.len(),
                contract_paths.len()
            );
        }
        let mut needed: HashMap<(String, String), HashSet<String>> = HashMap::new();
        let mut needed_exports = HashMap::<String, HashSet<String>>::new();
        for (checked, runtime) in &pairs {
            if let Some(exports) = demands.exports.get(runtime) {
                needed_exports
                    .entry(checked.clone())
                    .or_default()
                    .extend(exports.iter().cloned());
            }
            for ((path, name), members) in &demands.objects {
                if path == runtime {
                    needed
                        .entry((checked.clone(), name.clone()))
                        .or_default()
                        .extend(members.iter().cloned());
                }
            }
        }
        let mut lowerer = Lowerer::new(checker, source, console_prelude);
        lowerer.declaration_abi = true;
        let mut exports = Vec::new();
        let mut members = Vec::new();
        for file in &files {
            let file = *file;
            let path = source_file_info(file).file_name.to_string();
            if !contract_paths.contains(&path) || file.symbol().0 == 0 {
                continue;
            }
            // Resolving every export of a large declaration package is both
            // unnecessary and expensive: packages such as Effect expose
            // thousands of symbols through export-star barrels, while the
            // execution graph consumes only a small subset. Ask the checker
            // for those demanded names directly. Its module lookup still
            // resolves aliases and export-star chains, so this retains the
            // public TypeScript module semantics without materializing and
            // lowering the entire package namespace.
            let Some(wanted_exports) = needed_exports.get(&path) else {
                continue;
            };
            if std::env::var_os("SCRIPTC_TRACE_DECLARATION_CATALOG").is_some() {
                eprintln!(
                    "scriptc: declaration catalog file {path} ({} demanded exports)",
                    wanted_exports.len()
                );
            }
            let mut wanted_exports = wanted_exports.iter().collect::<Vec<_>>();
            wanted_exports.sort();
            for name in wanted_exports {
                if std::env::var_os("SCRIPTC_TRACE_DECLARATION_CATALOG").is_some() {
                    eprintln!("scriptc: declaration catalog export {path}::{name}");
                }
                let exported = lowerer
                    .checker
                    .try_get_member_in_module_exports(name, file.symbol());
                if exported.0 == 0 {
                    continue;
                }
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
                    rest: false,
                    params: vec![],
                    optional: vec![],
                    parametric_callback_results: vec![],
                    ret: None,
                    reason: None,
                    value_type: None,
                    class: None,
                };
                if constructors.len() == 1 {
                    let signature = constructors[0];
                    let trace_catalog =
                        std::env::var_os("SCRIPTC_TRACE_DECLARATION_CATALOG").is_some();
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
                            lowerer.type_id(id).or(Some(Type::Dyn))
                        })
                        .collect();
                    let instance = lowerer.checker.get_return_type_of_signature(signature);
                    let instance_symbol = lowerer.checker.ty(instance).symbol();
                    // `interface X` plus a same-named declared value is the
                    // common declaration shape for a JavaScript class/factory.
                    // Its body owns field storage and method ABIs; the checked
                    // interface is only a projection over that live identity.
                    let declaration_interface_value = if instance_symbol.0 == 0 {
                        false
                    } else {
                        let info = lowerer.checker.sym(instance_symbol);
                        let declaration = info.value_declaration;
                        if declaration.is_nil() {
                            false
                        } else {
                            let file = source_file_info(get_source_file_of_node(declaration));
                            info.flags.intersects(SymbolFlags::INTERFACE)
                                && info.flags.intersects(SymbolFlags::VALUE)
                                && is_declaration(&file.file_name)
                                && source_frontend::frontend::bundled::bundled_lib_name(
                                    &file.file_name,
                                )
                                .is_none()
                        }
                    };
                    let properties = lowerer.checker.get_properties_of_type(instance).to_vec();
                    if trace_catalog {
                        eprintln!(
                            "scriptc: declaration catalog class {path}::{name}: erased={erased}, {} properties",
                            properties.len()
                        );
                    }
                    let mut fields = Vec::new();
                    let mut methods = Vec::new();
                    for property in properties {
                        let info = lowerer.checker.sym(property);
                        let name = info.name.to_string();
                        if trace_catalog {
                            eprintln!("scriptc: declaration catalog class member {path}::{name}");
                        }
                        if info.flags.intersects(SymbolFlags::METHOD) {
                            let id = lowerer.checker.get_type_of_symbol(property);
                            let call_signatures = lowerer
                                .checker
                                .get_signatures_of_type(id, SignatureKind::CALL);
                            let returns_instance = call_signatures.len() == 1
                                && lowerer
                                    .checker
                                    .get_return_type_of_signature(call_signatures[0])
                                    == instance;
                            // Fluent and clone-style methods retain the same
                            // owning JavaScript instance. Expanding their
                            // declaration-only `this` parameters can force the
                            // checker through enormous recursive conditional
                            // graphs (Zod is a representative example), while
                            // also inventing copied record storage. Leave their
                            // implementation ABI demand-driven in the matching
                            // JavaScript body; call sites still keep the checked
                            // instance projection and native identity.
                            let signature = if declaration_interface_value || returns_instance {
                                None
                            } else if call_signatures.len() > 1 {
                                // Several overload views still describe one
                                // JavaScript method identity. Transport its
                                // arguments through the same erased rest ABI
                                // used for overloaded exported functions.
                                Some(Type::Func {
                                    rest: true,
                                    params: vec![Type::Array {
                                        elem: Box::new(Type::Dyn),
                                    }],
                                    ret: Box::new(Type::Dyn),
                                })
                            } else {
                                lowerer.function_type(id)
                            };
                            methods.push((name, signature));
                            continue;
                        }
                        // Public accessors carry a property contract too. The
                        // execution graph decides whether it is storage or a
                        // receiver-explicit getter/setter call.
                        let id = lowerer.checker.get_type_of_symbol(property);
                        fields.push((
                            name,
                            if erased || declaration_interface_value {
                                Some(Type::Dyn)
                            } else {
                                // A public JS field can carry an owning value
                                // whose declaration-only structure is outside
                                // the closed native type graph. Preserve the
                                // live payload instead of dropping the field
                                // contract altogether.
                                lowerer.type_id(id).or(Some(Type::Dyn))
                            },
                        ));
                    }
                    hint.class = Some(ClassHint {
                        constructor_declared: {
                            let declaration = lowerer.checker.sig(signature).declaration;
                            !declaration.is_nil()
                                && matches!(
                                    declaration.kind(),
                                    SyntaxKind::Constructor | SyntaxKind::ConstructSignature
                                )
                        },
                        params,
                        fields,
                        methods,
                    });
                } else if !signatures.is_empty() {
                    hint.optional = lowerer
                        .checker
                        .sig(signatures[0])
                        .parameters
                        .iter()
                        .map(|parameter| {
                            let info = lowerer.checker.sym(*parameter);
                            let declaration = info.value_declaration;
                            info.flags.intersects(SymbolFlags::OPTIONAL)
                                || (!declaration.is_nil()
                                    && declaration.kind() == SyntaxKind::Parameter
                                    && (!declaration.question_token().is_nil()
                                        || !declaration.initializer().is_nil()))
                        })
                        .collect();
                    // Polymorphic public signatures use an owned native value ABI.
                    // This preserves payloads instead of choosing an arbitrary overload.
                    if signatures.len() != 1
                        || !lowerer
                            .checker
                            .sig(signatures[0])
                            .type_parameters
                            .is_empty()
                    {
                        let generic = signatures.len() == 1
                            && !lowerer
                                .checker
                                .sig(signatures[0])
                                .type_parameters
                                .is_empty();
                        hint.value_type = lowerer.type_id(ty);
                        let public_parameters =
                            lowerer.checker.sig(signatures[0]).parameters.to_vec();
                        hint.parametric_callback_results = public_parameters
                            .iter()
                            .map(|parameter| {
                                let source = lowerer.checker.get_type_of_symbol(*parameter);
                                lowerer
                                    .checker
                                    .get_signatures_of_type(source, SignatureKind::CALL)
                                    .into_iter()
                                    .any(|callback| {
                                        let result =
                                            lowerer.checker.get_return_type_of_signature(callback);
                                        lowerer
                                            .checker
                                            .ty(result)
                                            .flags
                                            .intersects(TypeFlags::TYPE_PARAMETER)
                                    })
                            })
                            .collect();
                        hint.params = if signatures.len() == 1 && !generic {
                            public_parameters
                                .into_iter()
                                .map(|parameter| {
                                    let source = lowerer.checker.get_type_of_symbol(parameter);
                                    Some(lowerer.type_id(source).unwrap_or(Type::Dyn))
                                })
                                .collect()
                        } else {
                            public_parameters
                                .into_iter()
                                .map(|_| Some(Type::Dyn))
                                .collect()
                        };
                        hint.ret = Some(Type::Dyn);
                        if signatures.len() != 1 {
                            // Overloads are several checker views of one
                            // JavaScript function. Give that implementation a
                            // single erased variadic ABI instead of freezing
                            // the first overload's arity and parameter kinds.
                            // Fixed implementations are unpacked from this
                            // vector; native `...args` implementations consume
                            // it directly.
                            let params = vec![Type::Array {
                                elem: Box::new(Type::Dyn),
                            }];
                            hint.value_type = None;
                            hint.rest = true;
                            hint.params = params.into_iter().map(Some).collect();
                            hint.optional = vec![false];
                            hint.parametric_callback_results = vec![false];
                            hint.ret = Some(Type::Dyn);
                        } else if let Some(Type::Func {
                            rest: true,
                            params,
                            ret,
                        }) = &hint.value_type
                        {
                            hint.rest = true;
                            hint.params = params.iter().cloned().map(Some).collect();
                            hint.ret = Some((**ret).clone());
                        }
                    } else {
                        // Use the same signature adapter as first-class calls:
                        // a fixed tuple rest is a finite list of ABI slots.
                        if let Some(Type::Func { params, ret, rest }) =
                            lowerer.public_javascript_function_type(ty)
                        {
                            hint.rest = rest;
                            hint.params = params.into_iter().map(Some).collect();
                            hint.ret = Some(*ret);
                        } else {
                            hint.reason =
                                Some("public JavaScript signature has no fixed native ABI".into());
                        }
                        let declaration = lowerer.checker.sym(symbol).value_declaration;
                        if hint.reason.is_none()
                            && !lowerer.checker.get_properties_of_type(ty).is_empty()
                            // A declared function owns an ordinary property
                            // store independently of its call ABI. Namespace-
                            // merged data such as visit.BREAK therefore stays
                            // on the bare function identity; only structural
                            // callable values need a closed callable record.
                            && (declaration.is_nil()
                                || declaration.kind() != SyntaxKind::FunctionDeclaration)
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
                    let Some(wanted) = needed.get(&(path.clone(), name.clone())) else {
                        continue;
                    };
                    // A public object is not itself callable. Its method
                    // declarations still define implementation parameter ABIs.
                    // Resolve each member independently: an unrelated field
                    // with no portable layout must not erase a proven method.
                    for property in lowerer.checker.get_properties_of_type(ty).to_vec() {
                        if !wanted.contains(lowerer.checker.sym(property).name.as_ref()) {
                            continue;
                        }
                        if lowerer
                            .checker
                            .sym(property)
                            .flags
                            .intersects(SymbolFlags::ACCESSOR)
                        {
                            continue;
                        }
                        let id = lowerer.checker.get_type_of_symbol(property);
                        if let Some(signature) = lowerer.public_javascript_function_type(id) {
                            members.push(MemberExport {
                                file: path.clone(),
                                name: name.clone(),
                                member: lowerer.checker.sym(property).name.to_string(),
                                signature,
                            });
                        }
                    }
                    continue;
                }
                if std::env::var_os("SCRIPTC_TRACE_DECLARATION_CATALOG").is_some()
                    && !signatures.is_empty()
                {
                    eprintln!(
                        "scriptc: declaration catalog callable {path}::{name}: generic={}, params={:?}, optional={:?}, callback_results={:?}, ret={:?}",
                        !lowerer
                            .checker
                            .sig(signatures[0])
                            .type_parameters
                            .is_empty(),
                        hint.params,
                        hint.optional,
                        hint.parametric_callback_results,
                        hint.ret,
                    );
                }
                exports.push(Export {
                    file: path.clone(),
                    name: name.clone(),
                    hint,
                });
            }
        }
        if std::env::var("SCRIPTC_TRACE_PHASES").is_ok_and(|value| value == "1") {
            eprintln!(
                "scriptc: declaration catalog export scan finished: {} exports, {} members",
                exports.len(),
                members.len()
            );
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
                Type::Func { params, ret, .. } => {
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
                Type::Generator {
                    yield_type,
                    return_type,
                    next_type,
                    ..
                } => {
                    portable(yield_type, records, unions, seen)
                        && portable(return_type, records, unions, seen)
                        && portable(next_type, records, unions, seen)
                }
                Type::Map { key, value } => {
                    portable(key, records, unions, seen) && portable(value, records, unions, seen)
                }
                _ => true,
            }
        }
        fn portable_cached(
            ty: &Type,
            records: &[ir::Record],
            unions: &[ir::Union],
            cache: &mut HashMap<Type, bool>,
        ) -> bool {
            if let Some(result) = cache.get(ty) {
                return *result;
            }
            let result = portable(ty, records, unions, &mut HashSet::new());
            cache.insert(ty.clone(), result);
            result
        }
        fn project(
            lowerer: &mut Lowerer<'_>,
            node: Node,
            out: &mut HashMap<Key, Type>,
            projection_cache: &mut HashMap<TypeId, bool>,
            portable_cache: &mut HashMap<Type, bool>,
        ) {
            if !lowerer.declaration_abi
                && node.kind() == SyntaxKind::ObjectLiteralExpression
                && let Some(choice) = lowerer.contextual_union_literal(node)
                && portable_cached(&choice, &lowerer.records, &lowerer.unions, portable_cache)
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
                let declaration_projection = if let Some(result) = projection_cache.get(&id) {
                    *result
                } else {
                    let result = lowerer.declaration_projection(id);
                    projection_cache.insert(id, result);
                    result
                };
                if declaration_projection == lowerer.declaration_abi
                    && let Some(ty) = lowerer.type_id(id)
                    && portable_cached(&ty, &lowerer.records, &lowerer.unions, portable_cache)
                {
                    out.insert(Key::of(node), ty);
                }
            }
            node.for_each_child(&mut |child| {
                project(lowerer, child, out, projection_cache, portable_cache);
                false
            });
        }
        // Public data/callback views retain the implementation ABI. Resolve
        // concrete consumer views separately so that transport-mode cache
        // entries never erase local class or container storage.
        let mut projections = HashMap::new();
        // Interfaces implemented by classes are owning values in every
        // lowerer; project them consistently with the main pipeline.
        lowerer.inventory_implemented_interfaces(&files);
        for transport in [true, false] {
            if std::env::var("SCRIPTC_TRACE_PHASES").is_ok_and(|value| value == "1") {
                eprintln!(
                    "scriptc: declaration catalog {} projection started",
                    if transport { "checked" } else { "execution" }
                );
            }
            lowerer.declaration_abi = transport;
            if !transport {
                lowerer.types = type_graph::TypeCache::default();
            }
            let mut projection_cache = HashMap::new();
            let mut portable_cache = HashMap::new();
            for file in &files {
                let path = source_file_info(*file).file_name.to_string();
                if projection_paths.contains(&path)
                    && !is_declaration(&path)
                    && !is_javascript(&path)
                {
                    project(
                        &mut lowerer,
                        *file,
                        &mut projections,
                        &mut projection_cache,
                        &mut portable_cache,
                    );
                }
            }
            if std::env::var("SCRIPTC_TRACE_PHASES").is_ok_and(|value| value == "1") {
                eprintln!(
                    "scriptc: declaration catalog {} projection finished: {} projections",
                    if transport { "checked" } else { "execution" },
                    projections.len()
                );
            }
        }
        Catalog {
            projections,
            literal_choices: lowerer.literal_choices,
            edges,
            exports,
            members,
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
        // Resolve identical specifiers in corresponding importer modules.
        // This also handles package exports that put types and JS in wholly
        // different directories, without probing/guessing sibling filenames.
        let runtime_files = files
            .iter()
            .map(|file| source_file_info(*file).file_name.to_string())
            .collect::<Vec<_>>();
        let pairs = paired_paths(&self.edges, &execution_edges, &runtime_files);
        let namespace_aliases = pairs
            .iter()
            .filter(|(checked, runtime)| checked != runtime && is_declaration(checked))
            .map(|(checked, runtime)| (runtime.clone(), checked.clone()))
            .collect();
        let mut target_names = HashMap::<String, HashSet<String>>::new();
        for export in &self.exports {
            for (_, runtime) in pairs.iter().filter(|(checked, _)| *checked == export.file) {
                target_names
                    .entry(runtime.clone())
                    .or_default()
                    .insert(export.name.clone());
            }
        }
        for member in &self.members {
            for (_, runtime) in pairs.iter().filter(|(checked, _)| *checked == member.file) {
                target_names
                    .entry(runtime.clone())
                    .or_default()
                    .insert(member.name.clone());
            }
        }
        let mut targets = HashMap::new();
        let mut object_targets = HashMap::new();
        for file in files {
            let path = source_file_info(file).file_name.to_string();
            if !is_javascript(&path) || file.symbol().0 == 0 {
                continue;
            }
            let Some(names) = target_names.get(&path) else {
                continue;
            };
            let mut names = names.iter().collect::<Vec<_>>();
            names.sort();
            for name in names {
                let exported = checker.try_get_member_in_module_exports(name, file.symbol());
                if exported.0 == 0 {
                    continue;
                }
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
                    if node.kind() == SyntaxKind::VariableDeclaration
                        && !node.initializer().is_nil()
                    {
                        let initial = receivers::reference_node(node.initializer());
                        if !initial.is_nil()
                            && initial.kind() == SyntaxKind::ObjectLiteralExpression
                        {
                            object_targets.insert((path.clone(), name.clone()), initial);
                        }
                    }
                    targets.insert((path.clone(), name.clone()), Key::of(node));
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
        for member in self.members {
            for (_, runtime) in pairs.iter().filter(|(checked, _)| *checked == member.file) {
                let Some(object) = object_targets.get(&(runtime.clone(), member.name.clone()))
                else {
                    continue;
                };
                let matching = object
                    .properties()
                    .into_iter()
                    .filter(|property| {
                        matches!(
                            property.kind(),
                            SyntaxKind::MethodDeclaration | SyntaxKind::PropertyAssignment
                        ) && matches!(
                            property.name().kind(),
                            SyntaxKind::Identifier | SyntaxKind::StringLiteral
                        ) && property.name().text() == member.member
                    })
                    .collect::<Vec<_>>();
                // Duplicates/spreads require a source-order property plan.
                if matching.len() != 1
                    || object
                        .properties()
                        .into_iter()
                        .any(|p| p.kind() == SyntaxKind::SpreadAssignment)
                {
                    continue;
                }
                let property = matching[0];
                let function = if property.kind() == SyntaxKind::MethodDeclaration {
                    property
                } else {
                    receivers::reference_node(property.initializer())
                };
                if !matches!(
                    function.kind(),
                    SyntaxKind::MethodDeclaration
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::FunctionExpression
                ) {
                    continue;
                }
                let Type::Func { params, ret, rest } = &member.signature else {
                    unreachable!("member signature")
                };
                let hint = Hint {
                    rest: *rest,
                    params: params.iter().cloned().map(Some).collect(),
                    optional: vec![false; params.len()],
                    parametric_callback_results: vec![false; params.len()],
                    ret: Some((**ret).clone()),
                    reason: None,
                    value_type: None,
                    class: None,
                };
                let key = Key::of(function);
                if let Some(previous) = hints.get_mut(&key) {
                    if *previous != hint {
                        previous.reason = Some(
                            "conflicting public JavaScript method contracts are not ported".into(),
                        );
                    }
                } else {
                    hints.insert(key, hint);
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
            namespace_aliases,
        }
    }
}

fn is_javascript(path: &str) -> bool {
    path.ends_with(".js") || path.ends_with(".mjs")
}

impl Lowerer<'_> {
    pub(super) fn declared_callable_type(&self, id: TypeId) -> Option<Option<Type>> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let declaration = self.checker.sym(symbol).value_declaration;
        if declaration.is_nil()
            || !matches!(
                declaration.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::FunctionExpression
            )
        {
            return None;
        }
        let hint = self.declared(declaration)?;
        (hint.class.is_none()
            && (declaration.kind() != SyntaxKind::FunctionDeclaration || hint.value_type.is_none())
            && (hint.ret.is_some() || hint.reason.is_some()))
        .then(|| hint.function_type())
    }
    pub(super) fn declared(&self, node: Node) -> Option<&Hint> {
        if node.is_nil() {
            return None;
        }
        self.declarations.get(&Key::of(node))
    }
    pub(super) fn class_contract(&self, node: Node) -> Option<&ClassHint> {
        if node.is_nil() {
            return None;
        }
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

#[cfg(test)]
mod method_contract_tests {
    use super::*;

    #[test]
    fn module_pairing_keeps_multiple_implementations_and_terminates_cycles() {
        let edge = |importer: &str, specifier: &str, target: &str| Edge {
            importer: importer.into(),
            specifier: specifier.into(),
            target: target.into(),
        };
        let checked = vec![
            edge("entry.ts", "a", "types/api.d.ts"),
            edge("entry.ts", "b", "types/api.d.ts"),
            edge("types/api.d.ts", "./helper", "types/helper.d.ts"),
            edge("types/helper.d.ts", "./api", "types/api.d.ts"),
        ];
        let runtime = vec![
            edge("entry.ts", "a", "runtime/a.js"),
            edge("entry.ts", "b", "runtime/b.js"),
            edge("runtime/a.js", "./helper", "runtime/a-helper.js"),
            edge("runtime/b.js", "./helper", "runtime/b-helper.js"),
            edge("runtime/a-helper.js", "./api", "runtime/a.js"),
            edge("runtime/b-helper.js", "./api", "runtime/b.js"),
            edge("entry.ts", "unrelated", "runtime/unused.js"),
        ];
        let files = [
            "entry.ts",
            "runtime/a.js",
            "runtime/b.js",
            "runtime/a-helper.js",
            "runtime/b-helper.js",
            "runtime/unused.js",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        let pairs = paired_paths(&checked, &runtime, &files);
        assert_eq!(
            pairs,
            [
                ("entry.ts", "entry.ts"),
                ("types/api.d.ts", "runtime/a.js"),
                ("types/api.d.ts", "runtime/b.js"),
                ("types/helper.d.ts", "runtime/a-helper.js"),
                ("types/helper.d.ts", "runtime/b-helper.js"),
            ]
            .into_iter()
            .map(|(left, right)| (left.into(), right.into()))
            .collect()
        );
    }
}
