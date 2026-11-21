//! Checked source adaptation and lowering into scriptc-owned types and IR.
use crate::{
    builtins,
    ir::{self, Expr, Function, Loc, Local, Module, Param, Stmt, Type},
};
use source_frontend::{
    checker::Checker,
    flags::{ModifierFlags, NodeFlags, SymbolFlags, TypeFlags},
    prelude::{
        Node, SyntaxKind, TypeId, get_source_file_of_node, get_token_pos_of_node, source_file_info,
        source_file_text,
    },
    program,
};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
mod aggregates;
mod array_methods;
mod array_search;
mod arrays;
mod assertions;
mod assets;
mod async_context;
mod bigint;
mod bindings;
mod buffers;
mod bun;
mod bun_ffi;
mod callables;
mod callbacks;
mod child_process;
mod classes;
mod codecs;
mod collections;
mod commonjs;
mod comparisons;
mod conditional_facts;
mod console;
mod container_abi;
mod contextual_record_storage;
mod crypto;
mod data_tables;
mod declaration_abi;
mod declarations;
mod deletion;
mod directories;
mod dirents;
mod enums;
mod exceptions;
mod filesystem;
mod filesystem_glob;
mod filesystem_reads;
mod filesystem_writes;
mod for_of;
mod function_completion;
mod function_properties;
mod function_reflection;
mod functions;
mod generators;
mod helpers;
pub mod inspect;
mod inspector_session;
mod intl;
mod json_functions;
mod json_modules;
mod local_storage;
mod logical;
mod loops;
mod module_graph;
mod module_metadata;
pub(crate) mod modules;
mod namespace_values;
mod native_fetch;
mod native_net;
mod native_url;
mod number_constructor;
mod number_parsers;
mod number_predicates;
mod numeric_binary;
mod object_methods;
mod object_presence;
mod optional_access;
mod parameter_abi;
mod parameter_patterns;
mod parameters;
mod pipeline;
mod primitives;
mod process;
mod promises;
mod property_access;
mod property_keys;
mod proxy;
mod receivers;
mod record_construction;
mod recursive_closures;
mod reflection;
mod regex;
mod regex_captures;
mod runtime_types;
mod sequence_bindings;
mod sets;
mod sqlite;
mod standard_functions;
mod standard_objects;
mod stats;
mod storage;
mod string_construction;
mod string_decoder;
mod string_index;
mod strings;
mod switch;
mod symbols;
mod timers;
mod tuples;
mod type_graph;
mod typed_arrays;
mod types;
mod union_literals;
mod union_spreads;
mod updates;
mod values;
mod vars;
mod weak_maps;
mod weak_references;
mod zlib;

pub const REVISION: &str = "780dc512d64f40afebffa6a7028207649fb7ed1c";

pub(crate) fn path_for_frontend(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!("//{}", unc.replace('\\', "/"))
    } else {
        text.strip_prefix(r"\\?\")
            .unwrap_or(&text)
            .replace('\\', "/")
    }
}

pub use pipeline::{diagnose, lower};

fn needs_execution_view() -> bool {
    fn has_literal_require(node: Node) -> bool {
        if node.kind() == SyntaxKind::CallExpression
            && node.expression().kind() == SyntaxKind::Identifier
            && node.expression().text() == "require"
        {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if matches!(arguments.as_slice(), [specifier] if specifier.kind() == SyntaxKind::StringLiteral)
            {
                return true;
            }
        }
        let mut found = false;
        node.for_each_child(&mut |child| {
            found = has_literal_require(child);
            found
        });
        found
    }
    program::source_files().into_iter().any(|file| {
        if is_declaration(&source_file_info(file).file_name) {
            return false;
        }
        if crate::project::contains_jsx(file) {
            return true;
        }
        if has_literal_require(file) {
            return true;
        }
        // A dynamic-only entry can resolve against a declaration contract in
        // the checked program. Its executable package body is loaded by the
        // execution view just like a static import.
        if !modules::dynamic_imports(file).is_empty() {
            return true;
        }
        program::with_type_checker_for_file(file, move |checker| {
            file.statements().into_iter().any(|node| {
                let Some(specifier) = modules::runtime_specifier(node) else {
                    return false;
                };
                if builtins::module(specifier.text()).is_some() {
                    return false;
                }
                let symbol = checker.get_symbol_at_location(specifier, false);
                if symbol.0 == 0 {
                    return false;
                }
                let target = checker.sym(symbol).value_declaration;
                !target.is_nil()
                    && target.kind() == SyntaxKind::SourceFile
                    && is_declaration(&source_file_info(target).file_name)
            })
        })
    })
}

fn is_declaration(path: &str) -> bool {
    [".d.ts", ".d.mts", ".d.cts"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
}

fn refusal(file: &str, node: Node, detail: &str) -> String {
    if node.is_nil() {
        return format!(
            "SCN1001: {file}:0..0: {detail} (synthetic node); native subset only, no fallback"
        );
    }
    format!(
        "SCN1001: {file}:{}..{}: {detail}; native subset only, no fallback",
        node.pos(),
        node.end()
    )
}

#[derive(Clone)]
struct Signature {
    is_async: bool,
    generator: Option<ir::GeneratorChannels>,
    rest: bool,
    node: Node,
    file: String,
    name: String,
    params: Vec<Param>,
    return_type: Type,
}

struct Lowerer<'a> {
    diagnostic_errors: Option<Vec<String>>,
    checker: &'a mut Checker,
    console_prelude: Option<String>,
    console_global: Option<(ir::Global, Expr)>,
    entry_file: String,
    file: String,
    locals: Vec<Local>,
    bindings: HashMap<u32, Local>,
    module_bindings: HashMap<u32, Local>,
    default_exports: HashMap<declarations::Key, Local>,
    default_aliases: HashMap<u32, u32>,
    unobserved_default_exports: HashSet<declarations::Key>,
    globals: Vec<ir::Global>,
    functions: functions::FunctionGraph,
    return_type: Option<Type>,
    is_async_function: bool,
    generator: Option<ir::GeneratorChannels>,
    native_functions: HashMap<u32, (&'static str, String)>,
    native_namespaces: HashMap<u32, &'static str>,
    native_require_calls: HashMap<declarations::Key, &'static str>,
    native_local_symbols: HashSet<u32>,
    native_dynamic_values: HashSet<u32>,
    ambiguous_native_targets: HashSet<u32>,
    json_imports: HashSet<u32>,
    records: Vec<ir::Record>,
    unions: Vec<ir::Union>,
    types: type_graph::TypeCache,
    type_stack: Vec<TypeId>,
    outer: Vec<HashMap<u32, Local>>,
    captures: Vec<(u32, Param)>,
    recursive_functions: HashMap<u32, Type>,
    hoisted_function_initializers: HashSet<u32>,
    caught_aliases: HashMap<u32, Local>,
    lifted: LiftedFunctions,
    next_closure: usize,
    helpers: HashMap<(String, Vec<Type>, Type), String>,
    dynamic_constructors: Vec<(String, usize, Node)>,
    declarations: HashMap<declarations::Key, declarations::Hint>,
    declaration_abi: bool,
    projections: std::sync::Arc<HashMap<declarations::Key, Type>>,
    literal_choices: HashMap<declarations::Key, Type>,
    contextual_record_storage: HashMap<u32, Type>,
    planned_local_storage: HashMap<u32, Type>,
    classes: classes::ClassGraph,
    instance_this: Option<Local>,
    module_vars: HashMap<u32, Type>,
    // Value contracts for undefined-capable var/parameter/deferred let cells.
    var_types: HashMap<u32, Type>,
    var_defined: HashSet<u32>,
    nested_assignment_symbols: HashSet<u32>,
    js_absence_parameters: HashSet<u32>,
    js_null_parameters: HashSet<u32>,
    // Concrete slots proven from every direct use of a private JavaScript
    // function. Public/escaping functions retain their declaration ABI.
    js_parameter_types: HashMap<u32, Type>,
    absence_returns: HashSet<u32>,
    absence_assignments: HashSet<u32>,
    js_absent_fields: HashSet<(TypeId, String)>,
    enums: enums::EnumGraph,
    callables: HashMap<usize, Type>,
    polymorphic_callables: HashMap<u32, usize>,
    data_bindings: HashSet<u32>,
    data_types: HashSet<TypeId>,
    nominal_return_functions: HashSet<u32>,
    commonjs: commonjs::Graph,
    namespace_values: namespace_values::NamespaceValues,
    // Runtime source path -> checked declaration path. A declaration module
    // and its JavaScript implementation use one namespace capsule ABI while
    // retaining distinct module slots and object identities.
    namespace_aliases: HashMap<String, String>,
    receiver_calls: Vec<receivers::PendingCall>,
    asset_initializers: Vec<Stmt>,
    lazy_modules: HashMap<String, String>,
    missing_dynamic_imports: HashSet<declarations::Key>,
}

/// Lifted closure bodies are append-only during lowering. Share each body so
/// speculative diagnostic forks copy pointers instead of whole functions.
#[derive(Clone, Default)]
struct LiftedFunctions(Vec<std::sync::Arc<Function>>);

impl LiftedFunctions {
    fn push(&mut self, function: Function) {
        self.0.push(std::sync::Arc::new(function));
    }

    fn len(&self) -> usize {
        self.0.len()
    }

    fn truncate(&mut self, len: usize) {
        self.0.truncate(len);
    }

    fn find_mut(&mut self, name: &str) -> Option<&mut Function> {
        self.0
            .iter_mut()
            .find(|function| function.name == name)
            .map(std::sync::Arc::make_mut)
    }

    fn take(&mut self) -> Vec<Function> {
        std::mem::take(&mut self.0)
            .into_iter()
            .map(|function| std::sync::Arc::unwrap_or_clone(function))
            .collect()
    }
}

impl<'a> Lowerer<'a> {
    // Diagnostic probes share the checker, but every mutable lowering graph is
    // copied so a failed probe cannot contaminate another one or a real build.
    fn diagnostic_fork(&mut self) -> Lowerer<'_> {
        macro_rules! fork {
            ($($field:ident),* $(,)?) => {
                Lowerer { checker: &mut *self.checker, $($field: self.$field.clone()),* }
            };
        }
        fork!(
            diagnostic_errors,
            console_prelude,
            console_global,
            entry_file,
            file,
            locals,
            bindings,
            module_bindings,
            default_exports,
            default_aliases,
            unobserved_default_exports,
            globals,
            functions,
            return_type,
            is_async_function,
            generator,
            native_functions,
            native_namespaces,
            native_require_calls,
            native_local_symbols,
            native_dynamic_values,
            ambiguous_native_targets,
            json_imports,
            records,
            unions,
            types,
            type_stack,
            outer,
            captures,
            recursive_functions,
            hoisted_function_initializers,
            caught_aliases,
            lifted,
            next_closure,
            helpers,
            dynamic_constructors,
            declarations,
            declaration_abi,
            projections,
            literal_choices,
            contextual_record_storage,
            planned_local_storage,
            classes,
            instance_this,
            module_vars,
            var_types,
            var_defined,
            nested_assignment_symbols,
            js_absence_parameters,
            js_null_parameters,
            js_parameter_types,
            absence_returns,
            absence_assignments,
            js_absent_fields,
            enums,
            callables,
            polymorphic_callables,
            data_bindings,
            data_types,
            nominal_return_functions,
            commonjs,
            namespace_values,
            namespace_aliases,
            receiver_calls,
            asset_initializers,
            lazy_modules,
            missing_dynamic_imports,
        )
    }

    // Checkpoints own only lowering state; the checker is shared and no
    // diagnostic recovery state can be published as executable IR.
    fn diagnostic_checkpoint(&self) -> impl FnOnce(&mut Self) + use<'a> {
        macro_rules! checkpoint {
            ($($field:ident),* $(,)?) => {{
                $(let $field = self.$field.clone();)*
                move |target: &mut Self| { $(target.$field = $field;)* }
            }};
        }
        checkpoint!(
            console_prelude,
            console_global,
            entry_file,
            file,
            locals,
            bindings,
            module_bindings,
            default_exports,
            default_aliases,
            unobserved_default_exports,
            globals,
            functions,
            return_type,
            is_async_function,
            generator,
            native_functions,
            native_namespaces,
            native_require_calls,
            native_local_symbols,
            native_dynamic_values,
            ambiguous_native_targets,
            json_imports,
            records,
            unions,
            types,
            type_stack,
            outer,
            captures,
            recursive_functions,
            hoisted_function_initializers,
            caught_aliases,
            lifted,
            next_closure,
            helpers,
            dynamic_constructors,
            declarations,
            declaration_abi,
            projections,
            literal_choices,
            contextual_record_storage,
            planned_local_storage,
            classes,
            instance_this,
            module_vars,
            var_types,
            var_defined,
            nested_assignment_symbols,
            js_absence_parameters,
            js_parameter_types,
            absence_returns,
            absence_assignments,
            js_absent_fields,
            enums,
            callables,
            polymorphic_callables,
            data_bindings,
            data_types,
            commonjs,
            namespace_values,
            namespace_aliases,
            receiver_calls,
            asset_initializers,
            lazy_modules,
            missing_dynamic_imports,
        )
    }

    fn new(checker: &'a mut Checker, file: String, console_prelude: Option<String>) -> Self {
        Self {
            diagnostic_errors: None,
            checker,
            console_prelude,
            console_global: None,
            entry_file: file.clone(),
            file,
            locals: Vec::new(),
            bindings: HashMap::new(),
            module_bindings: HashMap::new(),
            default_exports: HashMap::new(),
            default_aliases: HashMap::new(),
            unobserved_default_exports: HashSet::new(),
            globals: Vec::new(),
            functions: functions::FunctionGraph::default(),
            return_type: None,
            is_async_function: false,
            generator: None,
            native_functions: HashMap::new(),
            native_namespaces: HashMap::new(),
            native_require_calls: HashMap::new(),
            native_local_symbols: HashSet::new(),
            native_dynamic_values: HashSet::new(),
            ambiguous_native_targets: HashSet::new(),
            json_imports: HashSet::new(),
            records: Vec::new(),
            unions: Vec::new(),
            types: type_graph::TypeCache::default(),
            type_stack: Vec::new(),
            outer: Vec::new(),
            captures: Vec::new(),
            recursive_functions: HashMap::new(),
            hoisted_function_initializers: HashSet::new(),
            caught_aliases: HashMap::new(),
            lifted: LiftedFunctions::default(),
            next_closure: 0,
            helpers: HashMap::new(),
            dynamic_constructors: Vec::new(),
            declarations: HashMap::new(),
            declaration_abi: false,
            projections: Default::default(),
            literal_choices: HashMap::new(),
            contextual_record_storage: HashMap::new(),
            planned_local_storage: HashMap::new(),
            classes: classes::ClassGraph::default(),
            instance_this: None,
            module_vars: HashMap::new(),
            var_types: HashMap::new(),
            var_defined: HashSet::new(),
            nested_assignment_symbols: HashSet::new(),
            js_absence_parameters: HashSet::new(),
            js_null_parameters: HashSet::new(),
            js_parameter_types: HashMap::new(),
            absence_returns: HashSet::new(),
            absence_assignments: HashSet::new(),
            js_absent_fields: HashSet::new(),
            enums: enums::EnumGraph::default(),
            callables: HashMap::new(),
            polymorphic_callables: HashMap::new(),
            data_bindings: HashSet::new(),
            data_types: HashSet::new(),
            nominal_return_functions: HashSet::new(),
            commonjs: commonjs::Graph::default(),
            namespace_values: namespace_values::NamespaceValues::default(),
            namespace_aliases: HashMap::new(),
            receiver_calls: Vec::new(),
            asset_initializers: Vec::new(),
            lazy_modules: HashMap::new(),
            missing_dynamic_imports: HashSet::new(),
        }
    }
    fn bind_native_namespace(&mut self, node: Node, module: &'static str) {
        let local = self.checker.get_symbol_at_location(node, false).0;
        let target = self.symbol(node);
        if local == 0 {
            return;
        }
        // Distinct public modules can share declaration targets (path flavors).
        // Direct imports keep their own local provenance. A forwarded target is
        // usable only while every registration agrees on the same source API.
        if !self.ambiguous_native_targets.contains(&target) {
            if self
                .native_namespaces
                .get(&target)
                .is_some_and(|previous| *previous != module)
            {
                self.native_namespaces.remove(&target);
                self.ambiguous_native_targets.insert(target);
            } else {
                self.native_namespaces.insert(target, module);
            }
        }
        self.native_local_symbols.insert(local);
        self.native_local_symbols.insert(target);
        self.native_namespaces.insert(local, module);
    }

    fn bind_native_function(&mut self, node: Node, module: &'static str, member: &str) {
        let local = self.checker.get_symbol_at_location(node, false).0;
        let target = self.symbol(node);
        if local == 0 {
            return;
        }
        let binding = (module, member.to_owned());
        if !self.ambiguous_native_targets.contains(&target) {
            if self
                .native_functions
                .get(&target)
                .is_some_and(|previous| *previous != binding)
            {
                self.native_functions.remove(&target);
                self.ambiguous_native_targets.insert(target);
            } else {
                self.native_functions.insert(target, binding.clone());
            }
        }
        self.native_local_symbols.insert(local);
        self.native_functions.insert(local, binding);
    }

    fn bind_native_member(&mut self, node: Node, module: &'static str, member: &str) {
        let namespace = Self::native_member_namespace(module, member);
        if let Some(namespace) = namespace {
            self.bind_native_namespace(node, namespace);
        } else {
            self.bind_native_function(node, module, member);
        }
    }

    fn native_member_namespace(module: &'static str, member: &str) -> Option<&'static str> {
        match (module, member) {
            ("path" | "path/win32", "posix") => Some("path"),
            ("path" | "path/win32", "win32") => Some("path/win32"),
            ("fs", "promises") => Some("fs/promises"),
            ("dns", "promises") => Some("dns/promises"),
            ("readline", "promises") => Some("readline/promises"),
            ("stream", "promises") => Some("stream/promises"),
            ("util", "types") => Some("util/types"),
            _ => None,
        }
    }

    fn bind_native_pattern(&mut self, pattern: Node, module: &'static str) {
        if pattern.kind() != SyntaxKind::ObjectBindingPattern {
            return;
        }
        for element in pattern.elements() {
            if element.kind() != SyntaxKind::BindingElement || !element.dot_dot_dot_token().is_nil()
            {
                continue;
            }
            let member = element.property_name_or_name().text();
            if element.name().kind() == SyntaxKind::Identifier {
                self.bind_native_member(element.name(), module, member);
            } else if element.name().kind() == SyntaxKind::ObjectBindingPattern
                && let Some(namespace) = Self::native_member_namespace(module, member)
            {
                self.bind_native_pattern(element.name(), namespace);
            }
        }
    }

    fn native_require_pattern_value(&mut self, pattern: Node) -> Result<Expr, String> {
        if pattern.kind() == SyntaxKind::Identifier {
            let native = self.native_symbol(pattern);
            let binding = self.native_functions.get(&native).cloned();
            let class = match binding
                .as_ref()
                .map(|(module, member)| (*module, member.as_str()))
            {
                Some(("stream", "Transform" | "PassThrough")) => {
                    Some(self.node_transform_class(pattern))
                }
                Some(("stream", "Duplex")) => Some(self.node_duplex_class(pattern)),
                Some(("stream", "Readable")) => Some(self.node_readable_class(pattern)),
                Some(("stream", "Writable")) => Some(self.node_writable_class(pattern)),
                Some(("console", "Console")) => Some(self.node_console_class(pattern)),
                Some(("events", "EventEmitter")) => Some(self.event_emitter_class(pattern)),
                _ => None,
            };
            if let Some(class) = class {
                self.classes.register_symbol(native, class);
                let resolved = self.symbol(pattern);
                if resolved != 0 {
                    self.classes.register_symbol(resolved, class);
                }
                let value = self.class_ref(class, pattern, None)?;
                return self.coerce(value, Type::Dyn, pattern);
            }
            let value = self.expression(pattern)?;
            return self.coerce(value, Type::Dyn, pattern);
        }
        if pattern.kind() != SyntaxKind::ObjectBindingPattern {
            return Err(self.refuse(
                pattern,
                "native require bindings need named non-rest object members",
            ));
        }
        let mut fields = Vec::new();
        for element in pattern.elements() {
            if element.kind() != SyntaxKind::BindingElement
                || !element.dot_dot_dot_token().is_nil()
                || !matches!(
                    element.name().kind(),
                    SyntaxKind::Identifier | SyntaxKind::ObjectBindingPattern
                )
            {
                return Err(self.refuse(
                    element,
                    "native require bindings need named non-rest object members",
                ));
            }
            fields.push(ir::DynamicField {
                key: Expr::StrLit {
                    value: element.property_name_or_name().text().to_owned(),
                    r#type: Type::String,
                    loc: self.loc(element),
                },
                value: self.native_require_pattern_value(element.name())?,
            });
        }
        Ok(Expr::DynObjLit {
            fields,
            r#type: Type::Dyn,
            loc: self.loc(pattern),
        })
    }

    fn native_import(&mut self, node: Node, module: &'static str) {
        fn walk(node: Node, nodes: &mut Vec<Node>) {
            nodes.push(node);
            node.for_each_child(&mut |child: Node| {
                walk(child, nodes);
                false
            });
        }
        let mut nodes = Vec::new();
        walk(node, &mut nodes);
        let clause = node.import_clause();
        let default = if clause.is_nil() {
            Node::NIL
        } else {
            clause.name()
        };
        if !default.is_nil() {
            self.bind_native_namespace(default, module);
        }
        for node in nodes {
            if node.is_type_only() {
                continue;
            }
            match node.kind() {
                SyntaxKind::ImportSpecifier | SyntaxKind::ExportSpecifier => {
                    let member = node.property_name_or_name().text();
                    self.bind_native_member(node.name(), module, member);
                }
                SyntaxKind::NamespaceImport => {
                    self.bind_native_namespace(node.name(), module);
                }
                _ => {}
            }
        }
    }

    fn native_namespace(&mut self, node: Node) -> Option<&'static str> {
        if node.kind() == SyntaxKind::CallExpression
            && let Some(module) = self.native_require_calls.get(&declarations::Key::of(node))
        {
            return Some(*module);
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(node);
            if let Some(module) = self.native_namespaces.get(&symbol) {
                return Some(*module);
            }
            if node.text() == "Bun" {
                let id = self.checker.get_symbol_at_location(node, false);
                if id.0 != 0
                    && self.checker.sym(id).declarations.iter().any(|declaration| {
                        !declaration.is_nil() && {
                            let path = &source_file_info(
                                source_frontend::prelude::get_source_file_of_node(*declaration),
                            )
                            .file_name;
                            path.contains("bun-types")
                        }
                    })
                {
                    return Some("Bun");
                }
            }
            if node.text() == "process" {
                let symbol = self.checker.get_symbol_at_location(node, false);
                if symbol.0 == 0 {
                    return None;
                }
                let symbol = self.checker.sym(symbol);
                // Ambient globals frequently have no `value_declaration`: the
                // checker only records their merged declaration set.  Looking
                // at the value declaration alone made `process` disappear when
                // an async try/catch body was split into a continuation.
                let native_process = std::iter::once(symbol.value_declaration)
                    .chain(symbol.declarations.iter().copied())
                    .filter(|declaration| !declaration.is_nil())
                    .any(|declaration| {
                        let file = source_frontend::ast::get_source_file_of_node(declaration);
                        let path = &source_file_info(file).file_name;
                        path.contains("/node_modules/@types/node/")
                            || path.contains("\\node_modules\\@types\\node\\")
                            || path.contains("bun-types")
                    });
                if native_process {
                    return Some("process");
                }
            }
            if node.text() == "crypto" {
                let symbol = self.checker.get_symbol_at_location(node, false);
                if symbol.0 != 0
                    && self
                        .checker
                        .sym(symbol)
                        .declarations
                        .iter()
                        .any(|declaration| {
                            if declaration.is_nil() {
                                return false;
                            }
                            let path = &source_file_info(
                                source_frontend::ast::get_source_file_of_node(*declaration),
                            )
                            .file_name;
                            path.ends_with("lib.dom.d.ts")
                                || path.contains("bun-types")
                                || path.contains("@types/node")
                        })
                {
                    return Some("crypto");
                }
            }
        } else if node.kind() == SyntaxKind::PropertyAccessExpression {
            if node.name().text() == "crypto"
                && node.expression().kind() == SyntaxKind::Identifier
                && node.expression().text() == "globalThis"
            {
                let symbol = self
                    .checker
                    .get_symbol_at_location(node.expression(), false);
                let declared_ambient = symbol.0 != 0
                    && self
                        .checker
                        .sym(symbol)
                        .declarations
                        .iter()
                        .any(|declaration| {
                            if declaration.is_nil() {
                                return false;
                            }
                            let path = &source_file_info(
                                source_frontend::ast::get_source_file_of_node(*declaration),
                            )
                            .file_name;
                            source_frontend::frontend::bundled::bundled_lib_name(path).is_some()
                                || path.contains("bun-types")
                        });
                let lexical = symbol.0 != 0
                    && (self.bindings.contains_key(&symbol.0)
                        || self.module_bindings.contains_key(&symbol.0)
                        || self
                            .outer
                            .iter()
                            .rev()
                            .any(|scope| scope.contains_key(&symbol.0)));
                let ambient = declared_ambient || symbol.0 != 0 && !lexical;
                if ambient {
                    return Some("crypto");
                }
            }
            let base = self.native_namespace(node.expression())?;
            if node.name().text() == "default" {
                // TypeScript's CommonJS `__importDefault(require("node:*"))`
                // wrapper exposes the builtin namespace through `.default`.
                // The wrapper itself is erased; preserve the module routing.
                return Some(base);
            }
            if base == "Bun" && node.name().text() == "TOML" {
                return Some("Bun.TOML");
            }
            if base == "util" && node.name().text() == "types" {
                return Some("util/types");
            }
            if base == "path" || base == "path/win32" {
                return match node.name().text() {
                    "posix" => Some("path"),
                    "win32" => Some("path/win32"),
                    _ => None,
                };
            }
        }
        None
    }

    fn native_dynamic_result_binding(&mut self, node: Node) -> Option<(&'static str, String)> {
        let node = primitives::primitive_source(node);
        if node.kind() != SyntaxKind::CallExpression {
            return None;
        }
        let callee = primitives::primitive_source(node.expression());
        let binding = if callee.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(callee);
            self.native_functions.get(&symbol).cloned()
        } else if callee.kind() == SyntaxKind::PropertyAccessExpression {
            self.native_namespace(callee.expression())
                .map(|module| (module, callee.name().text().to_owned()))
        } else {
            None
        };
        let Some((module, member)) = binding else {
            return None;
        };
        builtins::source(module, &member)
            .is_some_and(|api| {
                !api.operations.is_empty()
                    && api
                        .operations
                        .iter()
                        .all(|operation| operation.result == Type::Dyn)
            })
            .then_some((module, member))
    }

    fn native_dynamic_result_call(&mut self, node: Node) -> bool {
        self.native_dynamic_result_binding(node).is_some() || self.object_descriptor_result(node)
    }

    fn owning_function_result_call(&mut self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        if node.is_nil() || node.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let symbol = self.call_target(node.expression(), &mut HashSet::new());
        symbol != 0
            && self.nominal_return_functions.contains(&symbol)
            && self.functions.source_node(symbol).is_some_and(|source| {
                source.asterisk_token().is_nil()
                    && !source.modifier_flags().intersects(ModifierFlags::ASYNC)
            })
    }

    // An inferred local initialized from an asserted array lookup still
    // owns the actual JavaScript value, including an absent slot. The `!`
    // assertion changes no runtime value.
    fn inferred_nonnull_array_element(&mut self, declaration: Node) -> bool {
        if !declaration.type_().is_nil() || declaration.initializer().is_nil() {
            return false;
        }
        let initializer = declaration.initializer();
        if initializer.kind() != SyntaxKind::NonNullExpression {
            return false;
        }
        let access = primitives::primitive_source(initializer);
        access.kind() == SyntaxKind::ElementAccessExpression
            && matches!(self.ty(access.expression()), Ok(Type::Array { .. }))
    }

    fn inferred_nonnull_array_removal(&mut self, declaration: Node) -> bool {
        if !declaration.type_().is_nil()
            || declaration.initializer().is_nil()
            || declaration.initializer().kind() != SyntaxKind::NonNullExpression
        {
            return false;
        }
        let call = primitives::primitive_source(declaration.initializer());
        if call.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let member = call.expression();
        member.kind() == SyntaxKind::PropertyAccessExpression
            && matches!(member.name().text().as_ref(), "pop" | "shift")
            && matches!(self.ty(member.expression()), Ok(Type::Array { .. }))
    }

    fn object_descriptor_result(&mut self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        if node.is_nil()
            || node.kind() != SyntaxKind::CallExpression
            || !parameter_abi::is_javascript(node)
        {
            return false;
        }
        let member = node.expression();
        member.kind() == SyntaxKind::PropertyAccessExpression
            && member.name().text() == "getOwnPropertyDescriptor"
            && self.standard_object(member.expression())
    }

    fn native_computed_symbol_result_call(&mut self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        if node.kind() == SyntaxKind::ConditionalExpression {
            return self.native_computed_symbol_result_call(node.when_true())
                || self.native_computed_symbol_result_call(node.when_false());
        }
        if node.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let member = primitives::primitive_source(node.expression());
        if member.kind() != SyntaxKind::ElementAccessExpression {
            return false;
        }
        let key = primitives::primitive_source(member.argument_expression());
        key.kind() == SyntaxKind::PropertyAccessExpression
            && self.standard_symbol(key.expression())
            && ir::well_known_symbol(&format!("sym.{}", key.name().text())).is_some()
    }

    fn native_callable_value(&mut self, node: Node) -> bool {
        if self.timer_callable_value(node) {
            return true;
        }
        if node.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(node);
            if cfg!(windows)
                && self
                    .native_functions
                    .get(&symbol)
                    .is_some_and(|(module, member)| *module == "process" && member == "getuid")
            {
                return false;
            }
            return self.native_functions.contains_key(&symbol);
        }
        if cfg!(windows)
            && node.kind() == SyntaxKind::PropertyAccessExpression
            && node.name().text() == "getuid"
            && self.native_namespace(node.expression()) == Some("process")
        {
            return false;
        }
        node.kind() == SyntaxKind::PropertyAccessExpression
            && self
                .native_namespace(node.expression())
                .is_some_and(|module| builtins::source(module, node.name().text()).is_some())
    }

    fn native_property_read(&mut self, node: Node) -> Option<Expr> {
        let (module, member) = if node.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(node);
            self.native_functions.get(&symbol).cloned()?
        } else if node.kind() == SyntaxKind::PropertyAccessExpression {
            (
                self.native_namespace(node.expression())?,
                node.name().text().to_owned(),
            )
        } else {
            return None;
        };
        let property = builtins::property(module, &member)?;
        if !property.args.is_empty() {
            return None;
        }
        Some(Expr::LibCall {
            r#fn: property.ir.into(),
            args: vec![],
            r#type: property.result,
            loc: self.loc(node),
        })
    }

    /// Materialize a registered direct native call as an ordinary JavaScript
    /// function value. Keeping this adapter driven by the builtin manifest
    /// prevents direct-call and callback support from drifting apart while
    /// leaving overload- and syntax-sensitive lowerings on their dedicated
    /// frontend paths.
    fn native_function_value(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let (module, member) = if node.kind() == SyntaxKind::Identifier {
            let symbol = self.native_symbol(node);
            let Some(binding) = self.native_functions.get(&symbol).cloned() else {
                return Ok(None);
            };
            binding
        } else if node.kind() == SyntaxKind::PropertyAccessExpression {
            let Some(module) = self.native_namespace(node.expression()) else {
                return Ok(None);
            };
            (module, node.name().text().to_owned())
        } else {
            return Ok(None);
        };
        self.native_function_binding_value(node, module, &member)
    }

    fn native_function_binding_value(
        &mut self,
        node: Node,
        module: &'static str,
        member: &str,
    ) -> Result<Option<Expr>, String> {
        let Some(api) = builtins::source(module, member) else {
            return Ok(None);
        };
        if cfg!(windows) && module == "process" && member == "getuid" {
            return Ok(Some(Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            }));
        }
        if module == "fs/promises" && api.lowering == builtins::Lowering::Special {
            return self.fs_promise_function_value(node, &member);
        }
        if matches!(
            api.lowering,
            builtins::Lowering::PathVariadic | builtins::Lowering::PathBasename
        ) && let [builtin] = api.operations.as_slice()
        {
            // `const utils = { join, basename }`: the function value keeps the
            // call-site contract of the variadic/optional-suffix lowering.
            let variadic = api.lowering == builtins::Lowering::PathVariadic;
            let params = if variadic {
                vec![builtins::strings()]
            } else {
                vec![Type::String, Type::Dyn]
            };
            let mut helper = helpers::Helper::new(
                &format!("native_{}_{}_value", module.replace('/', "_"), member),
                params.clone(),
                builtin.result.clone(),
                self.loc(node),
            );
            let args = if variadic {
                vec![helper.read(&helper.param(0))]
            } else {
                let loc = helper.loc();
                let suffix = helper.read(&helper.param(1));
                vec![
                    helper.read(&helper.param(0)),
                    Expr::Ternary {
                        cond: Box::new(Expr::DynTest {
                            value: Box::new(suffix.clone()),
                            test: "undefined".into(),
                            negated: false,
                            r#type: Type::Bool,
                            loc: loc.clone(),
                        }),
                        then: Box::new(Expr::StrLit {
                            value: String::new(),
                            r#type: Type::String,
                            loc: loc.clone(),
                        }),
                        else_: Box::new(Expr::DynCheck {
                            value: Box::new(suffix),
                            r#type: Type::String,
                            loc: loc.clone(),
                        }),
                        r#type: Type::String,
                        loc,
                    },
                ]
            };
            let call = Expr::LibCall {
                r#fn: builtin.ir.into(),
                args,
                r#type: builtin.result.clone(),
                loc: helper.loc(),
            };
            helper.function.body.push(Stmt::Return {
                value: Some(call),
                loc: helper.loc(),
            });
            if variadic {
                helper.function.rest = true;
            }
            return Ok(Some(Expr::Closure {
                fn_name: self.install_helper(helper.function),
                captures: vec![],
                r#type: Type::Func {
                    params,
                    ret: Box::new(builtin.result.clone()),
                    rest: variadic,
                },
                loc: self.loc(node),
            }));
        }
        let builtin = if module == "crypto" && member == "createSign" {
            api.operations
                .iter()
                .find(|operation| operation.ir == "crypto.signNew")
                .expect("registered Sign constructor")
        } else {
            // Single-operation Buffer helpers (`isUtf8`, `isAscii`) have the
            // same direct value contract as ordinary direct builtins.
            if !(api.lowering == builtins::Lowering::Direct
                || (api.lowering == builtins::Lowering::Buffer && module == "buffer"))
                || api.operations.len() != 1
            {
                return Ok(None);
            }
            &api.operations[0]
        };
        self.ensure_exception_classes(node)?;
        let mut helper = helpers::Helper::new(
            &format!("native_{}_{}_value", module.replace('/', "_"), member),
            builtin.args.clone(),
            builtin.result.clone(),
            self.loc(node),
        );
        let args = (0..builtin.args.len())
            .map(|index| helper.read(&helper.param(index)))
            .collect();
        let call = Expr::LibCall {
            r#fn: builtin.ir.into(),
            args,
            r#type: builtin.result.clone(),
            loc: helper.loc(),
        };
        if builtin.result == Type::Void {
            helper.function.body.push(Stmt::Expression {
                expr: call,
                loc: helper.loc(),
            });
            helper.function.body.push(Stmt::Return {
                value: None,
                loc: helper.loc(),
            });
        } else {
            helper.function.body.push(Stmt::Return {
                value: Some(call),
                loc: helper.loc(),
            });
        }
        let r#type = Type::Func {
            params: builtin.args.clone(),
            ret: Box::new(builtin.result.clone()),
            rest: false,
        };
        Ok(Some(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type,
            loc: self.loc(node),
        }))
    }

    fn native_module_namespace_value(
        &mut self,
        node: Node,
        module: &'static str,
    ) -> Result<Expr, String> {
        let mut fields = Vec::new();
        for member in builtins::direct_value_members(module) {
            let Some(value) = self.native_function_binding_value(node, module, member)? else {
                continue;
            };
            fields.push(ir::DynamicField {
                key: Expr::StrLit {
                    value: member.to_owned(),
                    r#type: Type::String,
                    loc: self.loc(node),
                },
                value: self.coerce(value, Type::Dyn, node)?,
            });
        }
        Ok(Expr::DynObjLit {
            fields,
            r#type: Type::Dyn,
            loc: self.loc(node),
        })
    }

    fn fs_promise_function_value(
        &mut self,
        node: Node,
        member: &str,
    ) -> Result<Option<Expr>, String> {
        let params = match member {
            "mkdir" | "readFile" | "rm" => vec![Type::String, Type::Dyn],
            "appendFile" => vec![Type::String, Type::String, Type::String],
            "writeFile" => vec![Type::String, Type::String, Type::Dyn],
            _ => return Ok(None),
        };
        self.ensure_exception_classes(node)?;
        let loc = self.loc(node);
        let mut helper = helpers::Helper::new(
            &format!("native_fs_promises_{member}_value"),
            params.clone(),
            Type::Dyn,
            loc.clone(),
        );
        let reads = (0..params.len())
            .map(|index| helper.read(&helper.param(index)))
            .collect::<Vec<_>>();
        let dynamic_field = |object: &Expr, name: &str| Expr::DynKeyGet {
            value: Box::new(object.clone()),
            key: Box::new(Expr::StrLit {
                value: name.into(),
                r#type: Type::String,
                loc: loc.clone(),
            }),
            r#type: Type::Dyn,
            loc: loc.clone(),
        };
        let defaulted = |value: Expr, default: Expr, target: Type| Expr::Ternary {
            cond: Box::new(Expr::DynTest {
                value: Box::new(value.clone()),
                test: "undefined".into(),
                negated: false,
                r#type: Type::Bool,
                loc: loc.clone(),
            }),
            then: Box::new(default),
            else_: Box::new(Expr::DynCheck {
                value: Box::new(value),
                r#type: target.clone(),
                loc: loc.clone(),
            }),
            r#type: target,
            loc: loc.clone(),
        };
        let call = match member {
            "appendFile" => Expr::LibCall {
                r#fn: "fs.appendFilePromise".into(),
                args: vec![
                    reads[0].clone(),
                    reads[1].clone(),
                    Expr::NumLit {
                        value: 0o666 as f64,
                        spelling: Some("0o666".into()),
                        r#type: Type::F64,
                        loc: loc.clone(),
                    },
                    Expr::BoolLit {
                        value: false,
                        r#type: Type::Bool,
                        loc: loc.clone(),
                    },
                ],
                r#type: Type::Promise {
                    inner: Box::new(Type::Void),
                },
                loc: loc.clone(),
            },
            "mkdir" => {
                let mode = dynamic_field(&reads[1], "mode");
                let recursive = dynamic_field(&reads[1], "recursive");
                Expr::LibCall {
                    r#fn: "fs.mkdirPromise".into(),
                    args: vec![
                        reads[0].clone(),
                        defaulted(
                            mode,
                            Expr::NumLit {
                                value: -1.0,
                                spelling: None,
                                r#type: Type::F64,
                                loc: loc.clone(),
                            },
                            Type::F64,
                        ),
                        defaulted(
                            recursive,
                            Expr::BoolLit {
                                value: false,
                                r#type: Type::Bool,
                                loc: loc.clone(),
                            },
                            Type::Bool,
                        ),
                    ],
                    r#type: Type::Promise {
                        inner: Box::new(Type::Dyn),
                    },
                    loc: loc.clone(),
                }
            }
            "readFile" => Expr::LibCall {
                r#fn: "fs.readFilePromise".into(),
                args: vec![
                    reads[0].clone(),
                    Expr::DynCheck {
                        value: Box::new(reads[1].clone()),
                        r#type: Type::String,
                        loc: loc.clone(),
                    },
                ],
                r#type: Type::Promise {
                    inner: Box::new(Type::String),
                },
                loc: loc.clone(),
            },
            "rm" => {
                let recursive = dynamic_field(&reads[1], "recursive");
                let force = dynamic_field(&reads[1], "force");
                Expr::LibCall {
                    r#fn: "fs.rmPromise".into(),
                    args: vec![
                        reads[0].clone(),
                        defaulted(
                            recursive,
                            Expr::BoolLit {
                                value: false,
                                r#type: Type::Bool,
                                loc: loc.clone(),
                            },
                            Type::Bool,
                        ),
                        defaulted(
                            force,
                            Expr::BoolLit {
                                value: false,
                                r#type: Type::Bool,
                                loc: loc.clone(),
                            },
                            Type::Bool,
                        ),
                    ],
                    r#type: Type::Promise {
                        inner: Box::new(Type::Void),
                    },
                    loc: loc.clone(),
                }
            }
            "writeFile" => {
                let mode = dynamic_field(&reads[2], "mode");
                let flag = dynamic_field(&reads[2], "flag");
                let flush = dynamic_field(&reads[2], "flush");
                let exclusive = Expr::DynScalarEq {
                    left: Box::new(flag),
                    right: Box::new(Expr::DynFrom {
                        value: Box::new(Expr::StrLit {
                            value: "wx".into(),
                            r#type: Type::String,
                            loc: loc.clone(),
                        }),
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    }),
                    negated: false,
                    r#type: Type::Bool,
                    loc: loc.clone(),
                };
                let default_mode = Expr::Ternary {
                    cond: Box::new(exclusive.clone()),
                    then: Box::new(Expr::NumLit {
                        value: 0o666 as f64,
                        spelling: Some("0o666".into()),
                        r#type: Type::F64,
                        loc: loc.clone(),
                    }),
                    else_: Box::new(Expr::NumLit {
                        value: -1.0,
                        spelling: None,
                        r#type: Type::F64,
                        loc: loc.clone(),
                    }),
                    r#type: Type::F64,
                    loc: loc.clone(),
                };
                Expr::LibCall {
                    r#fn: "fs.writeFilePromise".into(),
                    args: vec![
                        reads[0].clone(),
                        reads[1].clone(),
                        defaulted(mode, default_mode, Type::F64),
                        exclusive,
                        defaulted(
                            flush,
                            Expr::BoolLit {
                                value: false,
                                r#type: Type::Bool,
                                loc: loc.clone(),
                            },
                            Type::Bool,
                        ),
                    ],
                    r#type: Type::Promise {
                        inner: Box::new(Type::Void),
                    },
                    loc: loc.clone(),
                }
            }
            _ => unreachable!("filtered fs/promises function value"),
        };
        let call = self.coerce(call, Type::Dyn, node)?;
        helper.function.body.push(Stmt::Return {
            value: Some(call),
            loc: loc.clone(),
        });
        Ok(Some(Expr::Closure {
            fn_name: self.install_helper(helper.function),
            captures: vec![],
            r#type: Type::Func {
                params,
                ret: Box::new(Type::Dyn),
                rest: false,
            },
            loc,
        }))
    }

    fn module_namespace(&mut self, node: Node) -> bool {
        if self.commonjs_import(node).is_some() {
            return false;
        }
        if node.kind() != SyntaxKind::Identifier {
            return false;
        }
        let symbol = self.checker.get_symbol_at_location(node, false);
        if symbol.0 == 0
            || !self
                .checker
                .sym(symbol)
                .flags
                .intersects(SymbolFlags::ALIAS)
        {
            return false;
        }
        if self.commonjs.local_symbols.contains(&symbol.0) {
            return false;
        }
        let target = self.checker.get_aliased_symbol(symbol);
        if target.0 == 0 {
            return false;
        }
        let declaration = self.checker.sym(target).value_declaration;
        !declaration.is_nil() && declaration.kind() == SyntaxKind::SourceFile
    }

    /// Node descriptor operations whose JavaScript arguments stay erased:
    /// callback forms of `open/write/close/fsync/mkdir`, plus `writeSync`
    /// with string or dynamic data and `fsyncSync`.
    fn fs_descriptor_transport(&mut self, node: Node, member: &str) -> Result<Option<Expr>, String> {
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        let ir = match member {
            "open" | "write" | "close" | "fsync" | "mkdir"
                if builtins::source("fs", member).is_none() =>
            {
                match member {
                    "open" => "fs.callbackOpen",
                    "write" => "fs.callbackWrite",
                    "close" => "fs.callbackClose",
                    "fsync" => "fs.callbackFsync",
                    _ => "fs.callbackMkdir",
                }
            }
            "writeSync"
                if arguments.len() <= 3
                    && arguments
                        .get(1)
                        .is_some_and(|data| self.ty(*data).ok() != Some(Type::bytes())) =>
            {
                "fs.dynamicWriteSync"
            }
            "fsyncSync" if builtins::source("fs", member).is_none() => "fs.dynamicFsyncSync",
            _ => return Ok(None),
        };
        if arguments
            .iter()
            .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "fs descriptor argument spreads are not ported"));
        }
        let mut elems = Vec::with_capacity(arguments.len());
        for argument in arguments {
            let value = self.expression(argument)?;
            elems.push(self.coerce(value, Type::Dyn, argument)?);
        }
        Ok(Some(Expr::LibCall {
            r#fn: ir.into(),
            args: vec![Expr::ArrayLit {
                elems,
                r#type: Type::Array {
                    elem: Box::new(Type::Dyn),
                },
                loc: self.loc(node),
            }],
            r#type: Type::Dyn,
            loc: self.loc(node),
        }))
    }

    fn native_call(&mut self, node: Node, module: &str, member: &str) -> Result<Expr, String> {
        if module == "fs"
            && let Some(value) = self.fs_descriptor_transport(node, member)?
        {
            return Ok(value);
        }
        let api = builtins::source(module, member).ok_or_else(|| {
            self.refuse(
                node,
                &format!("native library call '{module}.{member}' is not ported"),
            )
        })?;
        if module == "bun:ffi" && member == "dlopen" {
            return self.bun_ffi_dlopen(node);
        }
        if module == "Bun" && member == "spawn" {
            return self.bun_spawn(node);
        }
        if module == "Bun" && member == "connect" {
            return self.bun_connect(node);
        }
        if module == "tls" && member == "connect" {
            return self.tls_connect(node);
        }
        if module == "module" && member == "createRequire" {
            return self.module_create_require(node);
        }
        if module == "child_process" && member == "spawn" {
            return self.child_spawn(node);
        }
        if module == "dns" && member == "lookup" {
            self.ensure_exception_classes(node)?;
        }
        if module == "Bun" && member == "spawnSync" {
            return self.bun_spawn_sync(node);
        }
        if module == "Bun" && member == "which" {
            return self.bun_which(node);
        }
        if module == "Bun" && member == "write" {
            return self.bun_write(node);
        }
        if module == "Bun" && member == "file" {
            return self.bun_file(node);
        }
        if module == "events" && member == "once" {
            return self.events_once_drain(node);
        }
        if module == "fs/promises" {
            if member == "open"
                && let Some(call) = self.async_numeric_open_call(node)?
            {
                return Ok(call);
            }
            if member == "mkdir" {
                return self.async_directory_call(node);
            }
            if member == "rm" {
                return self.async_remove_call(node);
            }
            if member == "writeFile" {
                return self.async_write_file_call(node);
            }
            if member == "appendFile" {
                return self.async_append_file_call(node);
            }
            if member == "readFile" {
                return self.async_read_file_call(node);
            }
            if member == "readdir" {
                return self.async_read_directory_call(node);
            }
        }
        if module == "net" && member == "createConnection" {
            self.ensure_exception_classes(node)?;
        }
        if module == "crypto" && member == "createPrivateKey" {
            return Err(self.refuse(
                node,
                "materialized crypto KeyObject values are not ported; use the supported pkcs8/pem export chain",
            ));
        }
        if module == "process" && member == "kill" {
            let args = node.arguments().into_iter().collect::<Vec<_>>();
            if args.len() != 2
                || args
                    .iter()
                    .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "process.kill requires a numeric pid and one represented signal",
                ));
            }
            self.ensure_exception_classes(node)?;
            let pid = self.expected_expression(args[0], Type::F64)?;
            let signal = self.expression(args[1])?;
            let operation = match signal.ty() {
                Type::F64 => "process.killNum",
                Type::String => "process.killNamed",
                _ => {
                    return Err(self.refuse(
                        args[1],
                        "process.kill signal requires a represented number or string",
                    ));
                }
            };
            return Ok(Expr::LibCall {
                r#fn: operation.into(),
                args: vec![pid, signal],
                r#type: Type::Bool,
                loc: self.loc(node),
            });
        }
        if module == "process" && member == "exit" {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            self.ensure_exception_classes(node)?;
            let (operation, args) = match arguments.as_slice() {
                [] => ("process.exitDefault", vec![]),
                [argument] if argument.kind() != SyntaxKind::SpreadElement => {
                    let value = self.expression(*argument)?;
                    if value.ty() != Type::F64 {
                        return Err(self.refuse(*argument, "process.exit requires a numeric code"));
                    }
                    ("process.exit", vec![value])
                }
                _ => {
                    return Err(
                        self.refuse(node, "process.exit requires zero or one numeric argument")
                    );
                }
            };
            return Ok(Expr::LibCall {
                r#fn: operation.into(),
                args,
                r#type: Type::Void,
                loc: self.loc(node),
            });
        }
        if module == "process" && member == "emitWarning" {
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments.is_empty()
                || arguments.len() > 4
                || arguments
                    .iter()
                    .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "process.emitWarning accepts a warning and up to three metadata arguments",
                ));
            }
            self.ensure_exception_classes(node)?;
            let mut values = arguments
                .iter()
                .map(|argument| {
                    let value = self.expression(*argument)?;
                    self.coerce(value, Type::Dyn, *argument)
                })
                .collect::<Result<Vec<_>, String>>()?;
            while values.len() < 4 {
                values.push(self.coerce(
                    Expr::UnitLit {
                        unit: "undefined".into(),
                        r#type: Type::Undefined,
                        loc: self.loc(node),
                    },
                    Type::Dyn,
                    node,
                )?);
            }
            return Ok(Expr::LibCall {
                r#fn: "process.emitWarning".into(),
                args: values,
                r#type: Type::Void,
                loc: self.loc(node),
            });
        }
        if (module == "fs" && member == "accessSync")
            || (module == "fs/promises" && member == "access")
        {
            let asynchronous = module == "fs/promises";
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments.is_empty()
                || arguments.len() > 2
                || arguments
                    .iter()
                    .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
            {
                return Err(self.refuse(
                    node,
                    "fs access requires a string path and optional numeric mode",
                ));
            }
            self.ensure_exception_classes(node)?;
            let path = self.expected_expression(arguments[0], Type::String)?;
            let mode = if let Some(mode) = arguments.get(1) {
                self.expected_expression(*mode, Type::F64)?
            } else {
                Expr::NumLit {
                    value: 0.0,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(node),
                }
            };
            return Ok(Expr::LibCall {
                r#fn: if asynchronous {
                    "fs.accessPromise"
                } else {
                    "fs.accessSync"
                }
                .into(),
                args: vec![path, mode],
                r#type: if asynchronous {
                    Type::Promise {
                        inner: Box::new(Type::Void),
                    }
                } else {
                    Type::Void
                },
                loc: self.loc(node),
            });
        }
        if api.lowering == builtins::Lowering::Directory {
            return self.directory_call(node);
        }
        if api.lowering == builtins::Lowering::Copy {
            return self.copy_call(node);
        }
        if api.lowering == builtins::Lowering::Descriptor {
            return self.descriptor_call(node, member);
        }
        if api.lowering == builtins::Lowering::AppendFile {
            return self.append_file_call(node);
        }
        if api.lowering == builtins::Lowering::WriteFile {
            return self.write_file_call(node);
        }
        if api.lowering == builtins::Lowering::Remove {
            return self.remove_call(node);
        }
        if api.lowering == builtins::Lowering::ReadFile {
            return self.read_file_call(node);
        }
        if api.lowering == builtins::Lowering::ReadDirectory {
            return self.read_directory_call(node);
        }
        if api.lowering == builtins::Lowering::Glob {
            return self.glob_call(node);
        }
        if api.lowering == builtins::Lowering::Zlib {
            return self.zlib_call(node, member);
        }
        if module == "fs"
            && matches!(
                member,
                "statSync"
                    | "lstatSync"
                    | "fstatSync"
                    | "fchmodSync"
                    | "writeFileSync"
                    | "copyFileSync"
                    | "linkSync"
                    | "chmodSync"
                    | "unlinkSync"
                    | "renameSync"
            )
        {
            self.ensure_exception_classes(node)?;
        }
        let selected =
            if (matches!(module, "net" | "http")
                && member == "createServer"
                && node.arguments().len() == 1)
                || (module == "fs" && member == "createWriteStream" && node.arguments().len() == 1)
                || (module == "dns/promises"
                    && matches!(member, "resolve4" | "resolve6")
                    && node.arguments().len() == 2)
                || (module == "dns" && member == "lookup" && node.arguments().len() == 2)
            {
                api.operations.get(1)
            } else {
                api.operations.first()
            };
        let Some(builtin) = selected else {
            return Err(self.refuse(
                node,
                &format!(
                    "native library call '{module}.{member}' reached its special lowering without a callable ABI"
                ),
            ));
        };
        let argument_nodes = node.arguments().into_iter().collect::<Vec<_>>();
        let mut args = if api.lowering == builtins::Lowering::PathVariadic {
            let mut flattened = Vec::new();
            for argument in &argument_nodes {
                if argument.kind() != SyntaxKind::SpreadElement {
                    flattened.push(self.expected_expression(*argument, Type::String)?);
                    continue;
                }
                let source = primitives::primitive_source(argument.expression());
                let literal = if source.kind() == SyntaxKind::ArrayLiteralExpression {
                    source
                } else if source.kind() == SyntaxKind::Identifier {
                    let symbol = self.symbol(source);
                    let declaration = self
                        .checker
                        .sym(source_frontend::prelude::SymbolId(symbol))
                        .value_declaration;
                    if declaration.is_nil()
                        || declaration.kind() != SyntaxKind::VariableDeclaration
                        || !declaration.parent().flags().intersects(NodeFlags::CONST)
                    {
                        return Err(self.refuse(
                            *argument,
                            "path argument spread requires an immutable string tuple",
                        ));
                    }
                    primitives::primitive_source(declaration.initializer())
                } else {
                    Node::NIL
                };
                if literal.kind() != SyntaxKind::ArrayLiteralExpression
                    || literal.elements().into_iter().any(|element| {
                        !matches!(
                            element.kind(),
                            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
                        )
                    })
                {
                    return Err(self.refuse(
                        *argument,
                        "path argument spread requires a literal immutable string tuple",
                    ));
                }
                for element in literal.elements() {
                    flattened.push(self.expected_expression(element, Type::String)?);
                }
            }
            flattened
        } else {
            argument_nodes
                .iter()
                .enumerate()
                .map(|(index, arg)| {
                    if api.lowering == builtins::Lowering::Direct {
                        if let Some(expected) = builtin.args.get(index) {
                            self.expected_expression(*arg, expected.clone())
                        } else {
                            self.expression(*arg)
                        }
                    } else {
                        self.expression(*arg)
                    }
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        if api.lowering == builtins::Lowering::PathVariadic {
            if args.iter().any(|arg| arg.ty() != Type::String) {
                return Err(self.refuse(
                    node,
                    &format!(
                        "path arguments must be primitive strings; got {:?}",
                        args.iter().map(Expr::ty).collect::<Vec<_>>()
                    ),
                ));
            }
            args = vec![Expr::ArrayLit {
                elems: args,
                r#type: builtins::strings(),
                loc: self.loc(node),
            }];
        } else if api.lowering == builtins::Lowering::PathBasename && args.len() == 1 {
            args.push(Expr::StrLit {
                value: String::new(),
                r#type: Type::String,
                loc: self.loc(node),
            });
        }
        if module == "stream"
            && member == "pipeline"
            && let Some(destination) = args.get(1)
        {
            let destination_type = match destination {
                Expr::DynFrom { value, .. } => value.ty(),
                other => other.ty(),
            };
            self.classes.defer_dynamic_method_for_type(
                &destination_type,
                "_transform",
                &self.unions,
            );
        }
        if module == "net" && member == "connect" {
            self.ensure_exception_classes(node)?;
        }
        if api.lowering != builtins::Lowering::PathVariadic {
            // A declared scalar result can keep a wider owning ABI (for
            // example `string | undefined` after absence planning). When the
            // checker proves the exact scalar, check it at the library call.
            for (index, argument) in argument_nodes.iter().enumerate() {
                let (Some(arg), Some(expected)) = (args.get(index), builtin.args.get(index)) else {
                    continue;
                };
                // An erased byte argument (`isUtf8(chunk)` in JavaScript) is
                // checked as the native byte view, rejecting other values.
                let erased_bytes = arg.ty() == Type::Dyn && *expected == Type::bytes();
                if !erased_bytes
                    && (arg.ty() == *expected
                        || !matches!(expected, Type::String | Type::F64 | Type::Bool)
                        || !matches!(arg.ty(), Type::Union { .. } | Type::Dyn)
                        || self.ty(*argument).ok().as_ref() != Some(expected))
                {
                    continue;
                }
                let value = self.coerce(args[index].clone(), Type::Dyn, *argument)?;
                args[index] = Expr::DynCheck {
                    value: Box::new(value),
                    r#type: expected.clone(),
                    loc: self.loc(*argument),
                };
            }
        }
        if args.len() != builtin.args.len()
            || args
                .iter()
                .zip(&builtin.args)
                .any(|(arg, expected)| arg.ty() != *expected)
        {
            return Err(self.refuse(
                node,
                &format!(
                    "native library overload is not ported: {module}.{member} received {:?}, expected {:?}",
                    args.iter()
                        .map(|arg| self.contextual_type_description(&arg.ty()))
                        .collect::<Vec<_>>(),
                    builtin
                        .args
                        .iter()
                        .map(|ty| self.contextual_type_description(ty))
                        .collect::<Vec<_>>()
                ),
            ));
        }
        Ok(Expr::LibCall {
            r#fn: builtin.ir.into(),
            args,
            r#type: builtin.result.clone(),
            loc: self.loc(node),
        })
    }

    fn native_symbol(&mut self, node: Node) -> u32 {
        let local = self.checker.get_symbol_at_location(node, false).0;
        if self.native_local_symbols.contains(&local) {
            local
        } else {
            self.symbol(node)
        }
    }

    fn symbol(&mut self, node: Node) -> u32 {
        if node.is_nil()
            || matches!(
                node.kind(),
                SyntaxKind::ObjectBindingPattern | SyntaxKind::ArrayBindingPattern
            )
        {
            return 0;
        }
        let mut symbol = if !node.parent().is_nil()
            && node.parent().kind() == SyntaxKind::ShorthandPropertyAssignment
        {
            self.checker
                .get_shorthand_assignment_value_symbol(node.parent())
        } else {
            self.checker.get_symbol_at_location(node, false)
        };
        if let Some(target) = self.default_aliases.get(&symbol.0) {
            return *target;
        }
        if self.commonjs.local_symbols.contains(&symbol.0)
            && node.kind() == SyntaxKind::Identifier
            && let Some(local) = self.commonjs_lexical_symbol(node)
        {
            symbol = local;
        }
        if symbol.0 != 0
            && !self.commonjs.local_symbols.contains(&symbol.0)
            && self
                .checker
                .sym(symbol)
                .flags
                .intersects(SymbolFlags::ALIAS)
        {
            symbol = self.checker.get_aliased_symbol(symbol);
        }
        symbol.0
    }

    fn function_constructor_method_return(&mut self, node: Node) -> Option<Type> {
        if !parameter_abi::is_javascript(node)
            || !matches!(
                node.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor
            )
            || node.body().statements().len() != 1
        {
            return None;
        }
        let statement = node.body().statements().get(0);
        if statement.kind() != SyntaxKind::ReturnStatement || statement.expression().is_nil() {
            return None;
        }
        let value = primitives::primitive_source(statement.expression());
        if value.kind() != SyntaxKind::NewExpression
            || !self.standard_function_constructor_origin(value.expression(), &mut HashSet::new())
        {
            return None;
        }
        Some(Type::Func {
            rest: true,
            params: vec![Type::Array {
                elem: Box::new(Type::Dyn),
            }],
            ret: Box::new(Type::Dyn),
        })
    }

    fn planned_javascript_method_return(&mut self, node: Node, ordinal: usize) -> Option<Type> {
        if let Some(result) = self.function_constructor_method_return(node) {
            return Some(result);
        }
        if !parameter_abi::is_javascript(node)
            || !matches!(
                node.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor
            )
            || node.body().statements().len() != 1
        {
            return None;
        }
        let statement = node.body().statements().get(0);
        if statement.kind() != SyntaxKind::ReturnStatement || statement.expression().is_nil() {
            return None;
        }
        let value = receivers::reference_node(statement.expression());
        if value.kind() == SyntaxKind::PropertyAccessExpression
            && value.expression().kind() == SyntaxKind::ThisKeyword
            && let Some(class_name) = self.classes.definition_name_at(ordinal, node.parent())
        {
            let field = value.name().text();
            let ty = self.field_type(&class_name, field)?;
            if self.classes.guaranteed_string_presence(&class_name, field)
                && let Type::Union { union_id } = &ty
            {
                let present = self.unions[*union_id]
                    .arms
                    .iter()
                    .filter(|arm| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
                    .cloned()
                    .collect::<Vec<_>>();
                if let [present] = present.as_slice() {
                    return Some(present.clone());
                }
            }
            return Some(ty);
        }
        self.planned_argument_type(value)
    }

    fn function_signature(&mut self, node: Node, ordinal: usize) -> Result<Signature, String> {
        if node.body().is_nil() && !node.modifier_flags().intersects(ModifierFlags::ABSTRACT) {
            return Err(self.refuse(node, "function declaration requires an executable body"));
        }
        let mut declared = self.declared(node).cloned();
        let parameters = receivers::parameters(node);
        if parameter_abi::is_javascript(node)
            && let Some(hint) = declared.as_mut()
            && !hint.rest
            && hint.params.len() < parameters.len()
        {
            // Overload declarations commonly omit trailing implementation
            // slots used to disambiguate the public call forms. JavaScript
            // still receives those slots as undefined when callers omit them.
            hint.params.resize(parameters.len(), Some(Type::Dyn));
        }
        let rest = node
            .parameters()
            .iter()
            .last()
            .is_some_and(|p| !p.dot_dot_dot_token().is_nil());
        let public_type = declared
            .as_ref()
            .and_then(|hint| hint.value_type.clone().or_else(|| hint.function_type()));
        if std::env::var_os("SCRIPTC_TRACE_FUNCTION_SIGNATURE").is_some()
            && matches!(
                node.name().text(),
                "_gt" | "gt" | "_gte" | "gte" | "combine" | "issue"
            )
        {
            eprintln!(
                "scriptc: function signature {}:{}..{} name={} declared={declared:?} public={public_type:?}",
                self.file,
                node.pos(),
                node.end(),
                node.name().text(),
            );
        }
        let unpack_rest = parameter_abi::is_javascript(node)
            && (!rest || parameters.len() > 1)
            && public_type.as_ref().is_some_and(parameters::erased_rest)
            || parameters::arguments_reference(node).is_some();
        if rest && !node.type_parameters().is_empty() {
            return Err(self.refuse(node, "generic source rest parameters are not ported"));
        }
        if rest
            && node.kind() == SyntaxKind::MethodDeclaration
            && !node.modifier_flags().intersects(ModifierFlags::STATIC)
            && matches!(
                node.name().kind(),
                SyntaxKind::PrivateIdentifier | SyntaxKind::ComputedPropertyName
            )
        {
            return Err(self.refuse(
                node,
                "array-rest private and computed instance methods are not ported",
            ));
        }
        if let Some(hint) = &declared {
            if !unpack_rest && hint.rest != rest {
                return Err(self.refuse(
                    node,
                    "public JavaScript contract/implementation rest ABI differs",
                ));
            }
            if let Some(reason) = &hint.reason {
                return Err(self.refuse(node, reason));
            }
            if !unpack_rest
                && hint.params.len() != parameters.len()
                && !(parameter_abi::is_javascript(node)
                    && !rest
                    && !hint.rest
                    && hint.params.len() > parameters.len())
            {
                return Err(self.refuse(
                    node,
                    "public JavaScript contract/implementation arity differs",
                ));
            }
        }
        let mut params = Vec::new();
        for (index, param) in parameters.iter().copied().enumerate() {
            if !matches!(
                param.name().kind(),
                SyntaxKind::Identifier
                    | SyntaxKind::ObjectBindingPattern
                    | SyntaxKind::ArrayBindingPattern
            ) || (!param.dot_dot_dot_token().is_nil() && index + 1 != parameters.len())
            {
                return Err(self.refuse(
                    param,
                    "native parameters require identifiers or flat object patterns with a terminal array-rest slot",
                ));
            }
            if param.name().kind() == SyntaxKind::ObjectBindingPattern {
                self.validate_object_parameter(param)?;
            } else if param.name().kind() == SyntaxKind::ArrayBindingPattern {
                self.validate_array_parameter(param)?;
            }
            if unpack_rest {
                continue;
            }
            let declared_parameter = declared
                .as_ref()
                .and_then(|hint| hint.params.get(index))
                .and_then(|ty| ty.as_ref());
            if parameter_abi::is_javascript(param)
                && param.name().kind() == SyntaxKind::Identifier
                // A paired declaration owns the public ABI. In particular an
                // erased public slot is invariant: specializing it from the
                // first call would split aliases/reexports when a later call
                // transports another JavaScript value kind.
                && declared_parameter.is_none()
            {
                let symbol = self.parameter_symbol(param);
                if self
                    .js_parameter_types
                    .get(&symbol)
                    .is_none_or(|ty| *ty == Type::Dyn)
                {
                    let _ = self.late_parameter_type(param);
                }
            }
            let ty = if let Some(hint) = &declared {
                let symbol = self.parameter_symbol(param);
                let published = hint.params[index].clone();
                if self.js_parameter_types.get(&symbol) == Some(&Type::Dyn) {
                    Type::Dyn
                } else {
                    match published {
                        Some(Type::Dyn) => Type::Dyn,
                        Some(published) => self
                            .js_parameter_types
                            .get(&symbol)
                            .cloned()
                            .and_then(|planned| {
                                self.synchronous_iterable_argument(planned, &published)
                            })
                            .unwrap_or(published),
                        None => self
                            .js_parameter_types
                            .get(&symbol)
                            .cloned()
                            .ok_or_else(|| {
                                self.refuse(
                                    param,
                                    "public JavaScript parameter type has no native representation",
                                )
                            })?,
                    }
                }
            } else if matches!(
                param.name().kind(),
                SyntaxKind::ObjectBindingPattern | SyntaxKind::ArrayBindingPattern
            ) && parameter_abi::is_javascript(param)
                && param.type_().is_nil()
            {
                Type::Dyn
            } else {
                self.storage_type(param.name())?
            };
            let ty = if declared
                .as_ref()
                .and_then(|hint| hint.optional.get(index))
                .copied()
                .unwrap_or(false)
                && !self.optional_storage(&ty)
            {
                self.intern_union(vec![ty, Type::Undefined])
                    .ok_or_else(|| {
                        self.refuse(
                            param,
                            "optional declaration parameter has no native union ABI",
                        )
                    })?
            } else {
                ty
            };
            let ty = if !param.dot_dot_dot_token().is_nil()
                && matches!(&ty, Type::Record { shape_id } if self.records[*shape_id].tuple)
                && param.type_().kind() == SyntaxKind::TypeReference
                && param.type_().type_name().text() == "Parameters"
            {
                // A rest parameter receives a JavaScript arguments array even
                // when Parameters<F> gives it a fixed TypeScript tuple view.
                Type::Array {
                    elem: Box::new(Type::Dyn),
                }
            } else {
                ty
            };
            if !param.dot_dot_dot_token().is_nil() && !matches!(ty, Type::Array { .. }) {
                return Err(self.refuse(param, "rest parameter needs a native array ABI"));
            }
            params.push(Param {
                local_id: format!("p{index}"),
                name: if param.name().kind() == SyntaxKind::Identifier {
                    param.name().text().into()
                } else {
                    format!("binding{index}")
                },
                r#type: self.parameter_type(param, ty)?,
            });
        }
        if !unpack_rest && !rest && parameter_abi::is_javascript(node) {
            if let Some(hint) = &declared {
                for index in parameters.len()..hint.params.len() {
                    // JavaScript evaluates all supplied arguments even when the
                    // implementation has no corresponding formal parameter.
                    params.push(Param {
                        local_id: format!("p{index}"),
                        name: format!("unused_argument{index}"),
                        r#type: Type::Dyn,
                    });
                }
            }
        }
        if unpack_rest {
            params.push(Param {
                local_id: "p0".into(),
                name: "arguments".into(),
                r#type: Type::Array {
                    elem: Box::new(Type::Dyn),
                },
            });
        }
        let erase_private_result = declared.is_none()
            && node.asterisk_token().is_nil()
            && (self.file.ends_with(".js")
                || self.file.ends_with(".mjs")
                || self.file.ends_with(".cjs"))
            && params.iter().any(|p| p.r#type == Type::Dyn);
        let mut body_returns = Vec::new();
        if parameter_abi::is_javascript(node) && node.asterisk_token().is_nil() {
            parameter_abi::collect_returns(node.body(), &mut body_returns);
        }
        let has_value_return = body_returns
            .iter()
            .copied()
            .any(|expression| !expression.is_nil());
        let method_void = if !has_value_return
            && matches!(
                node.kind(),
                SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
            )
            && declared.is_none()
        {
            let signature = self.checker.get_signature_from_declaration(node);
            let result = self.checker.get_return_type_of_signature(signature);
            self.checker
                .ty(result)
                .flags
                .intersects(TypeFlags::VOID | TypeFlags::NEVER)
        } else {
            false
        };
        let mut return_type =
            if method_void {
                Type::Void
            } else if erase_private_result {
                Type::Dyn
            } else if unpack_rest && let Some(Type::Func { ret, .. }) = public_type {
                *ret
            } else if let Some(hint) = declared {
                let public = hint.ret.ok_or_else(|| {
                    self.refuse(
                        node,
                        "public JavaScript return type has no native representation",
                    )
                })?;
                let function_constructor = self.function_constructor_method_return(node);
                let public = if let Some(function_constructor) = function_constructor {
                    function_constructor
                } else if public == Type::Dyn {
                    self.planned_javascript_method_return(node, ordinal)
                        .unwrap_or(public)
                } else {
                    public
                };
                self.concrete_array_iterable_return(node, &public)
                    .unwrap_or(public)
            } else {
                let sig = self.checker.get_signature_from_declaration(node);
                let ret = self.checker.get_return_type_of_signature(sig);
                let flags = self.checker.ty(ret).flags;
                self.type_id(ret)
                .filter(|ty| !matches!(ty, Type::Null | Type::Undefined))
                .or_else(|| self.precise_stats_return(node))
                .or_else(|| self.planned_javascript_method_return(node, ordinal))
                .or_else(|| {
                    (!has_value_return
                        && flags.intersects(TypeFlags::VOID | TypeFlags::NEVER))
                        .then_some(Type::Void)
                })
                .or_else(|| {
                    if !flags.intersects(TypeFlags::UNION) {
                        return None;
                    }
                    let arms = self.checker.ty(ret).types();
                    let class_arms = arms.iter().filter(|arm| {
                        let symbol = self.checker.ty(**arm).symbol();
                        symbol.0 != 0
                            && self.checker.sym(symbol).flags.intersects(SymbolFlags::CLASS)
                    }).count();
                    (class_arms == 1 && arms.iter().all(|arm| {
                        let checked = self.checker.ty(*arm);
                        checked.flags.intersects(TypeFlags::NULL | TypeFlags::UNDEFINED)
                            || {
                                let symbol = checked.symbol();
                                symbol.0 != 0
                                    && self.checker.sym(symbol).flags.intersects(SymbolFlags::CLASS)
                            }
                    })).then_some(Type::Dyn)
                })
                // Generic TypeScript bodies have one runtime implementation
                // for every instantiation. When their mapped/conditional
                // result has no single closed layout, retain the owning value
                // and let each concrete call site install its checked view.
                .or_else(|| (!node.type_parameters().is_empty()).then_some(Type::Dyn))
                // JavaScript dependencies frequently expose nominal Node/Bun
                // handles whose implementation files have no representable
                // structural return type. Keep the private value erased; the
                // first supported member operation supplies its native brand.
                .or_else(|| parameter_abi::is_javascript(node).then_some(Type::Dyn))
                .ok_or_else(|| {
                    let class_arms = flags.intersects(TypeFlags::UNION)
                        && self
                            .checker
                            .ty(ret)
                            .types()
                            .iter()
                            .filter(|arm| {
                                let symbol = self.checker.ty(**arm).symbol();
                                symbol.0 != 0
                                    && self.checker.sym(symbol).flags.intersects(SymbolFlags::CLASS)
                            })
                            .count()
                            > 1;
                    let reason = if class_arms {
                        "function return union of class instances needs a shared identity contract"
                    } else {
                        "function return type is not ported"
                    };
                    self.refuse(node, reason)
                })?
            };
        if parameter_abi::is_javascript(node) && node.asterisk_token().is_nil() {
            // Make the published ABI agree with the implementation at the
            // point where the signature is created. Pre-planning can see a
            // different symbol through inherited declarations, aliases or
            // CommonJS pairing, and therefore cannot be the sole authority.
            let implementation_result = if node.modifier_flags().intersects(ModifierFlags::ASYNC) {
                match &return_type {
                    Type::Promise { inner } => inner.as_ref(),
                    _ => &return_type,
                }
            } else {
                &return_type
            };
            if body_returns.iter().copied().any(|expression| {
                if expression.is_nil() {
                    return false;
                }
                // Prefer the native planner's view. TypeScript can report the
                // inherited public result for a JavaScript method call even
                // when lowering the concrete implementation yields a Promise
                // or another owning value.
                let actual = self
                    .planned_argument_type(expression)
                    .or_else(|| self.ty(expression).ok())
                    .or_else(|| {
                        let checked = self.checker.get_type_at_location(expression);
                        self.type_id(checked)
                    });
                actual.is_some_and(|actual| {
                    !self.contextual_result_compatible(&actual, implementation_result)
                })
            }) {
                return_type = Type::Dyn;
            }
        }
        // Erasing a private JavaScript result must not erase the async
        // container itself. Callers and the lowering pipeline still need the
        // Promise identity and scheduling contract even when its payload is
        // only dynamically represented.
        let return_type = if node.modifier_flags().intersects(ModifierFlags::ASYNC)
            && node.asterisk_token().is_nil()
            && return_type == Type::Dyn
        {
            Type::Promise {
                inner: Box::new(Type::Dyn),
            }
        } else {
            return_type
        };
        let symbol = if node.name().is_nil() {
            // `export default function () {}` is the one legal anonymous
            // function declaration. The module owns its default symbol even
            // though there is no lexical name node.
            node.symbol().0
        } else {
            self.symbol(node.name())
        };
        if symbol == 0 {
            return Err(self.refuse(node, "function declaration has no resolved native symbol"));
        }
        let mut dynamic_json_returns = Vec::new();
        if params.iter().any(|param| param.r#type == Type::Dyn)
            && node.asterisk_token().is_nil()
            && !node.body().is_nil()
        {
            parameter_abi::collect_returns(node.body(), &mut dynamic_json_returns);
        }
        let returns_owning_json = dynamic_json_returns
            .into_iter()
            .any(|value| !value.is_nil() && self.json_stringify_result(value));
        let return_type = if self.nominal_return_functions.contains(&symbol) || returns_owning_json {
            match return_type {
                Type::Promise { .. } => Type::Promise {
                    inner: Box::new(Type::Dyn),
                },
                _ => Type::Dyn,
            }
        } else {
            return_type
        };
        let returns_null =
            parameter_abi::is_javascript(node) && self.function_absence_kinds(node).0;
        let returns_absence = self.absence_returns.contains(&symbol)
            || (parameter_abi::is_javascript(node) && self.function_may_return_absent(node))
            || returns_null;
        let return_type =
            if returns_absence && matches!(return_type, Type::F64 | Type::String | Type::Bool) {
                self.undefined_storage_type(return_type, node)?
            } else {
                return_type
            };
        let return_type = if returns_absence
            && node.asterisk_token().is_nil()
            && !node.modifier_flags().intersects(ModifierFlags::ASYNC)
            && !self.presence_storage(&return_type)
            && !matches!(return_type, Type::Dyn | Type::Void)
            && !matches!(return_type, Type::F64 | Type::String | Type::Bool)
        {
            let (returns_null, returns_undefined) = self.function_absence_kinds(node);
            if returns_null {
                // Unchecked JavaScript often reports only the successful
                // object arm even when the body explicitly returns null. A
                // structural Record | null union can recursively feed generic
                // map/filter contextualization; NativeValue is the stable
                // owning envelope for this private mixed result.
                Type::Dyn
            } else {
                let mut arms = vec![return_type.clone()];
                if returns_undefined || !returns_null {
                    arms.push(Type::Undefined);
                }
                self.intern_union(arms).ok_or_else(|| {
                    self.refuse(node, "function absence has no owning native return ABI")
                })?
            }
        } else {
            return_type
        };
        let is_generator = !node.asterisk_token().is_nil();
        // JavaScript declaration inventories may expose an erased public value
        // contract even though the checker retained the concrete Generator
        // channels on the implementation signature. Continuation lowering
        // needs those channels; keeping the whole function as Dyn would lose
        // both resume and yielded-value ABIs.
        let return_type = if is_generator && return_type == Type::Dyn {
            let signature = self.checker.get_signature_from_declaration(node);
            let checker_return = self.checker.get_return_type_of_signature(signature);
            self.generator_type(checker_return)
                .unwrap_or_else(|| Type::Generator {
                    r#async: node.modifier_flags().intersects(ModifierFlags::ASYNC),
                    yield_type: Box::new(Type::Dyn),
                    return_type: Box::new(Type::Void),
                    next_type: Box::new(Type::Dyn),
                })
        } else {
            return_type
        };
        let return_type = if is_generator && parameter_abi::is_javascript(node) {
            match return_type {
                Type::Generator {
                    r#async,
                    return_type,
                    next_type,
                    ..
                } => Type::Generator {
                    r#async,
                    yield_type: Box::new(Type::Dyn),
                    return_type,
                    next_type,
                },
                other => other,
            }
        } else {
            return_type
        };
        let generator = match (is_generator, &return_type) {
            (
                true,
                Type::Generator {
                    r#async,
                    yield_type,
                    next_type,
                    ..
                },
            ) if *r#async == node.modifier_flags().intersects(ModifierFlags::ASYNC) => {
                Some(ir::GeneratorChannels {
                    yield_type: (**yield_type).clone(),
                    next_type: (**next_type).clone(),
                })
            }
            (true, ty) => {
                return Err(self.refuse(
                    node,
                    &format!("generator channels have no native representation: {ty:?}"),
                ));
            }
            (false, _) => None,
        };
        Ok(Signature {
            is_async: node.modifier_flags().intersects(ModifierFlags::ASYNC),
            generator,
            rest: rest || unpack_rest,
            node,
            file: self.file.clone(),
            name: format!("f{ordinal}"),
            params,
            return_type,
        })
    }

    fn concrete_array_iterable_return(&mut self, node: Node, public: &Type) -> Option<Type> {
        let Type::Generator {
            r#async: false,
            yield_type,
            ..
        } = public
        else {
            return None;
        };
        if !parameter_abi::is_javascript(node) || !node.asterisk_token().is_nil() {
            return None;
        }
        fn collect(node: Node, root: Node, returns: &mut Vec<Node>) {
            node.for_each_child(&mut |child: Node| {
                if child.kind() == SyntaxKind::ReturnStatement {
                    if !child.expression().is_nil() {
                        returns.push(child.expression());
                    }
                } else if child == root
                    || !matches!(
                        child.kind(),
                        SyntaxKind::FunctionDeclaration
                            | SyntaxKind::FunctionExpression
                            | SyntaxKind::ArrowFunction
                            | SyntaxKind::MethodDeclaration
                            | SyntaxKind::ClassDeclaration
                            | SyntaxKind::ClassExpression
                    )
                {
                    collect(child, root, returns);
                }
                false
            });
        }
        let mut returns = Vec::new();
        collect(node.body(), node.body(), &mut returns);
        let mut concrete = None;
        for value in returns {
            let inferred = self.ty(value).ok()?;
            let elem = match inferred {
                Type::Array { elem }
                    if *elem == **yield_type || *elem == Type::Dyn || **yield_type == Type::Dyn =>
                {
                    yield_type.clone()
                }
                Type::Record { shape_id }
                    if self.records[shape_id].tuple
                        && self.records[shape_id]
                            .fields
                            .iter()
                            .all(|field| field.r#type == **yield_type) =>
                {
                    yield_type.clone()
                }
                _ if primitives::primitive_source(value).kind()
                    == SyntaxKind::ArrayLiteralExpression
                    && primitives::primitive_source(value)
                        .elements()
                        .into_iter()
                        .all(|element| {
                            element.kind() != SyntaxKind::SpreadElement
                                && self.ty(element).ok().as_ref() == Some(yield_type.as_ref())
                        }) =>
                {
                    yield_type.clone()
                }
                _ => return None,
            };
            let array = Type::Array { elem };
            if concrete.as_ref().is_some_and(|previous| *previous != array) {
                return None;
            }
            concrete = Some(array);
        }
        concrete
    }

    fn lower_function(&mut self, signature: Signature) -> Result<Function, String> {
        self.file = signature.file;
        if std::env::var_os("SCRIPTC_TRACE_FUNCTIONS").is_some() {
            eprintln!(
                "scriptc: lowering function {} at {}:{}..{}",
                signature.name,
                self.file,
                signature.node.pos(),
                signature.node.end()
            );
        }
        self.locals.clear();
        self.bindings.clear();
        self.captures.clear();
        self.var_types = self.module_vars.clone();
        let method = matches!(
            signature.node.kind(),
            SyntaxKind::MethodDeclaration | SyntaxKind::GetAccessor | SyntaxKind::SetAccessor
        ) && !signature
            .node
            .modifier_flags()
            .intersects(ModifierFlags::STATIC);
        let static_receiver = signature.node.kind() == SyntaxKind::MethodDeclaration
            && signature
                .node
                .modifier_flags()
                .intersects(ModifierFlags::STATIC)
            && signature.params.first().is_some_and(|param| {
                param.name == "this" && matches!(param.r#type, Type::Classval { .. })
            });
        for (node, param) in receivers::parameters(signature.node).into_iter().zip(
            signature
                .params
                .iter()
                .skip(usize::from(method || static_receiver)),
        ) {
            if node.name().kind() == SyntaxKind::Identifier {
                let symbol = self.symbol(node.name());
                self.var_types.insert(symbol, param.r#type.clone());
            }
        }
        self.plan_function_local_storage(signature.node)?;
        self.var_types = self.module_vars.clone();
        self.var_defined.clear();
        let body_return = if signature.generator.is_some() {
            let Type::Generator { return_type, .. } = &signature.return_type else {
                unreachable!("represented generator signature")
            };
            (**return_type).clone()
        } else if signature.is_async {
            let Type::Promise { inner } = &signature.return_type else {
                return Err(self.refuse(
                    signature.node,
                    "async function requires a native Promise result",
                ));
            };
            (**inner).clone()
        } else {
            signature.return_type.clone()
        };
        if signature.is_async {
            self.refuse_thenable(&body_return, signature.node)?;
        }
        self.return_type = Some(body_return.clone());
        self.is_async_function = signature.is_async;
        self.generator = signature.generator.clone();
        self.instance_this = None;
        let mut body = Vec::new();
        if method || static_receiver {
            self.bind_parameter(None, &signature.params[0])?;
            self.instance_this = Some(self.locals[0].clone());
        }
        if method
            && let Type::Object {
                class_name: receiver_class,
            } = &signature.params[0].r#type
            && let Some((owner_class, captures)) =
                self.classes.lexical_method_captures(signature.node)
        {
            let receiver = self
                .instance_this
                .as_ref()
                .expect("bound method receiver")
                .clone();
            for (index, (symbol, _, ty)) in captures.into_iter().enumerate() {
                let local =
                    self.construction_local(ty.clone(), self.mutable_lexical_binding(symbol));
                self.bindings.insert(symbol, local.clone());
                body.push(Stmt::VarDecl {
                    local_id: local.id.clone(),
                    init: Expr::LibCall {
                        r#fn: "class.capture".into(),
                        args: vec![
                            Expr::VarRef {
                                local_id: receiver.id.clone(),
                                r#type: Type::Object {
                                    class_name: receiver_class.clone(),
                                },
                                loc: self.loc(signature.node),
                            },
                            Expr::NumLit {
                                value: index as f64,
                                spelling: None,
                                r#type: Type::F64,
                                loc: self.loc(signature.node),
                            },
                            Expr::StrLit {
                                value: owner_class.clone(),
                                r#type: Type::String,
                                loc: self.loc(signature.node),
                            },
                        ],
                        r#type: ty,
                        loc: self.loc(signature.node),
                    },
                    loc: self.loc(signature.node),
                });
            }
        }
        if !method && !static_receiver {
            body.extend(self.initialize_receiver(signature.node)?);
        }
        let source_parameters = receivers::parameters(signature.node);
        let parameter_offset = usize::from(method || static_receiver);
        let abi_parameters = &signature.params[parameter_offset..];
        let unpack_rest = signature.rest
            && abi_parameters.len() == 1
            && matches!(&abi_parameters[0].r#type, Type::Array { elem } if **elem == Type::Dyn)
            && (parameter_abi::is_javascript(signature.node)
                || parameters::arguments_reference(signature.node).is_some())
            && (source_parameters.len() > 1
                || source_parameters
                    .last()
                    .is_none_or(|param| param.dot_dot_dot_token().is_nil()));
        if unpack_rest {
            body.extend(self.bind_parameter(None, &abi_parameters[0])?);
            if let Some(arguments) = parameters::arguments_reference(signature.node) {
                let symbol = self.symbol(arguments);
                if symbol != 0 {
                    let local = self
                        .locals
                        .last()
                        .expect("arguments transport local")
                        .clone();
                    self.bindings.insert(symbol, local);
                }
            }
            body.extend(self.bind_erased_rest_formals(&source_parameters, &abi_parameters[0])?);
        }
        let source_parameter_count = source_parameters.len();
        for (node, param) in source_parameters
            .into_iter()
            .zip(abi_parameters)
            .filter(|_| !unpack_rest)
        {
            body.extend(self.bind_parameter(Some(node), param)?);
        }
        if !unpack_rest {
            for param in abi_parameters.iter().skip(source_parameter_count) {
                body.extend(self.bind_parameter(None, param)?);
            }
        }
        body.extend(self.hoist_local_vars(signature.node.body())?);
        body.extend(self.hoist_forward_closures(signature.node.body())?);
        body.extend(self.statements(signature.node.body().statements())?);
        self.complete_function_body(
            &mut body,
            &body_return,
            signature.node,
            "non-void function fallthrough is not ported",
        )?;
        if signature.generator.is_some() {
            // Generator continuations outlive the native stack segment. Keep
            // every binding in an owning traced cell so loop helpers and
            // resumed closures share exactly one mutable JavaScript binding.
            for local in &mut self.locals {
                local.boxed = true;
            }
        }
        self.instance_this = None;
        self.is_async_function = false;
        self.generator = None;
        Ok(Function {
            is_async: signature.is_async,
            generator: signature.generator,
            rest: signature.rest,
            name: signature.name,
            params: signature.params,
            captures: None,
            return_type: body_return,
            locals: std::mem::take(&mut self.locals),
            body,
            loc: self.loc(signature.node),
        })
    }

    fn loc(&self, node: Node) -> Loc {
        // Helpers created while lowering declaration projections can carry a
        // synthetic/absent AST node.  A location is diagnostic metadata only;
        // asking the goported AST for `pos`/`end` on that sentinel panics
        // before the native subset can report or continue lowering it.
        if node.is_nil() {
            return Loc {
                file: self.file.clone(),
                start: 0,
                end: 0,
            };
        }
        Loc {
            file: self.file.clone(),
            start: node.pos().max(0),
            end: node.end(),
        }
    }
    fn refuse(&self, node: Node, detail: &str) -> String {
        refusal(&self.file, node, detail)
    }
    fn binding(&mut self, node: Node) -> Result<Local, String> {
        if let Some(binding) = self.commonjs_binding(node) {
            return Ok(binding);
        }
        let symbol = self.symbol(node);
        self.resolve_binding(symbol, node)
    }

    fn mutable_lexical_binding(&self, symbol: u32) -> bool {
        self.module_bindings
            .get(&symbol)
            .is_some_and(|binding| binding.mutable)
    }

    fn class_capture_assignment(&mut self, symbol: u32, value: Expr, site: Node) -> Option<Expr> {
        if !self.mutable_lexical_binding(symbol) {
            return None;
        }
        let receiver = self.instance_this.as_ref()?.clone();
        let Type::Object {
            class_name: receiver_class,
        } = &receiver.r#type
        else {
            return None;
        };
        let (capture, owner, r#type) = self
            .classes
            .mutable_capture_descriptor(receiver_class, symbol)?;
        Some(Expr::LibCall {
            r#fn: "class.captureSet".into(),
            args: vec![
                Expr::VarRef {
                    local_id: receiver.id,
                    r#type: receiver.r#type,
                    loc: self.loc(site),
                },
                Expr::NumLit {
                    value: capture as f64,
                    spelling: None,
                    r#type: Type::F64,
                    loc: self.loc(site),
                },
                Expr::StrLit {
                    value: owner,
                    r#type: Type::String,
                    loc: self.loc(site),
                },
                value,
            ],
            r#type,
            loc: self.loc(site),
        })
    }
    fn statements(
        &mut self,
        nodes: source_frontend::prelude::NodeSlice,
    ) -> Result<Vec<Stmt>, String> {
        let mut out = Vec::new();
        for node in nodes {
            out.extend(self.statement(node)?);
        }
        Ok(out)
    }
    fn statement(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        if self.diagnostic_errors.is_none() {
            return self.statement_inner(node);
        }
        let restore = self.diagnostic_checkpoint();
        match self.statement_inner(node) {
            Ok(statements) => Ok(statements),
            Err(error) => {
                restore(self);
                self.diagnostic_errors.as_mut().unwrap().push(error);
                Ok(Vec::new())
            }
        }
    }

    fn statement_inner(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        if node.is_nil() {
            return Err("SCN9001: frontend received an absent statement node".into());
        }
        if std::env::var("SCRIPTC_TRACE_STATEMENTS")
            .is_ok_and(|filter| filter == "1" || self.file.replace('\\', "/").contains(&filter))
        {
            eprintln!(
                "scriptc: lowering statement {:?} at {}:{}..{} (+{} ms)",
                node.kind(),
                self.file,
                node.pos(),
                node.end(),
                crate::trace_elapsed_ms()
            );
        }
        if let Some(body) = self.enum_statement(node)? {
            return Ok(body);
        }
        if let Some(body) = self.async_yield_star_statement(node)? {
            return Ok(body);
        }
        let loc = self.loc(node);
        let stmt = match node.kind() {
            SyntaxKind::ExportAssignment
                if self
                    .default_exports
                    .contains_key(&declarations::Key::of(node)) =>
            {
                let binding = self.default_exports[&declarations::Key::of(node)].clone();
                let value = self.expected_expression(node.expression(), binding.r#type)?;
                Stmt::Assign {
                    local_id: binding.id,
                    value,
                    initializes_global: true,
                    loc,
                }
            }
            SyntaxKind::ExportAssignment
                if self
                    .unobserved_default_exports
                    .contains(&declarations::Key::of(node)) =>
            {
                let value = self.expression(node.expression())?;
                let value = if matches!(value.ty(), Type::Null | Type::Undefined) {
                    self.coerce(value, Type::Dyn, node)?
                } else {
                    value
                };
                Stmt::Expression { expr: value, loc }
            }
            SyntaxKind::ClassDeclaration => return self.class_declaration(node),
            SyntaxKind::FunctionDeclaration
                if self.return_type.is_none() && node.parent().kind() == SyntaxKind::SourceFile =>
            {
                return Ok(vec![]);
            }
            SyntaxKind::FunctionDeclaration
                if self.return_type.is_some() || node.parent().kind() == SyntaxKind::Block =>
            {
                // Strict-mode block functions (for example in an `if` at
                // module scope) are block-scoped local bindings.
                return self.local_function_declaration(node);
            }
            SyntaxKind::ImportDeclaration | SyntaxKind::ExportDeclaration => return Ok(vec![]),
            SyntaxKind::TryStatement => return self.try_statement(node),
            SyntaxKind::WhileStatement => return self.while_statement(node),
            SyntaxKind::DoStatement => return self.do_statement(node),
            SyntaxKind::ForStatement => return self.for_statement(node),
            SyntaxKind::ForOfStatement => return self.for_of_statement(node),
            SyntaxKind::ForInStatement => return self.for_in_statement(node),
            SyntaxKind::LabeledStatement => return self.statement(node.statement()),
            SyntaxKind::SwitchStatement => return self.switch_statement(node),
            SyntaxKind::BreakStatement | SyntaxKind::ContinueStatement => self.loop_jump(node)?,
            SyntaxKind::ThrowStatement => {
                let value = self.expression(node.expression())?;
                let value = if matches!(value.ty(), Type::Null | Type::Undefined) {
                    self.coerce(value, Type::Dyn, node)?
                } else {
                    value
                };
                if value.ty() == Type::Void {
                    return Err(self.refuse(node, "void throw payload is not ported"));
                }
                Stmt::Throw { value, loc }
            }
            SyntaxKind::ReturnStatement => {
                let ret = self
                    .return_type
                    .clone()
                    .ok_or_else(|| self.refuse(node, "return outside a function"))?;
                if !node.expression().is_nil()
                    && let Some(body) = self.nested_await_return(node, &ret)?
                {
                    return Ok(body);
                }
                if !node.expression().is_nil()
                    && let Some(body) = self.nested_await_call_return(node, &ret)?
                {
                    return Ok(body);
                }
                if !node.expression().is_nil()
                    && let Some(body) = self.nested_await_string_method_return(node, &ret)?
                {
                    return Ok(body);
                }
                let value = if node.expression().is_nil() {
                    if ret == Type::Void {
                        None
                    } else {
                        Some(
                            self.undefined_return(ret.clone(), node)
                                .map_err(|_| self.refuse(node, "return coercion is not ported"))?,
                        )
                    }
                } else if self.is_async_function
                    && matches!(self.ty(node.expression()), Ok(Type::Promise { .. }))
                {
                    // `return promise` in an async function assimilates the
                    // promise exactly like a terminal await before settling
                    // the outer async result. Contextualize an erased
                    // JavaScript Promise payload from the represented async
                    // result; the resumed value is still checked before the
                    // outer promise is fulfilled.
                    let promise = self.expected_expression(
                        node.expression(),
                        Type::Promise {
                            inner: Box::new(ret.clone()),
                        },
                    )?;
                    Some(Expr::Await {
                        value: Box::new(promise),
                        r#type: ret.clone(),
                        loc: self.loc(node.expression()),
                    })
                } else if self.is_async_function
                    && self.ty(node.expression()).ok().is_some_and(|ty| {
                        matches!(ty, Type::Union { union_id } if self.unions[union_id]
                            .arms
                            .iter()
                            .any(|arm| matches!(arm, Type::Promise { .. })))
                    })
                {
                    // `return condition ? promise : value` in an async
                    // function adopts either branch through PromiseResolve.
                    // Keep the mixed owning value in NativeValue, then suspend
                    // once and check the fulfilled result against the declared
                    // async return ABI.
                    let value = self.expression(node.expression())?;
                    self.refuse_thenable(&value.ty(), node.expression())?;
                    let value = self.coerce(value, Type::Dyn, node.expression())?;
                    let promise = Expr::Intrinsic {
                        name: "promise.resolve".into(),
                        args: vec![value],
                        r#type: Type::Promise {
                            inner: Box::new(Type::Dyn),
                        },
                        loc: self.loc(node.expression()),
                    };
                    let awaited = Expr::Await {
                        value: Box::new(promise),
                        r#type: Type::Dyn,
                        loc: self.loc(node.expression()),
                    };
                    Some(self.coerce(awaited, ret.clone(), node.expression())?)
                } else if self.is_async_function
                    && !matches!(ret, Type::Promise { .. })
                    && primitives::primitive_source(node.expression()).kind()
                        == SyntaxKind::CallExpression
                    && matches!(self.ty(node.expression()), Ok(Type::Dyn))
                {
                    // An erased JavaScript receiver (`this` in a class with a
                    // dynamic base) can still resolve to a native async
                    // method. When the lowered call produces a represented
                    // Promise, `return call()` assimilates it like a terminal
                    // await; any other result keeps the ordinary boundary.
                    let value = self.expression(node.expression())?;
                    if matches!(value.ty(), Type::Promise { .. }) {
                        let promise = self.coerce(
                            value,
                            Type::Promise {
                                inner: Box::new(ret.clone()),
                            },
                            node.expression(),
                        )?;
                        Some(Expr::Await {
                            value: Box::new(promise),
                            r#type: ret.clone(),
                            loc: self.loc(node.expression()),
                        })
                    } else {
                        Some(self.coerce(value, ret.clone(), node.expression())?)
                    }
                } else if node.expression().kind() == SyntaxKind::AwaitExpression {
                    let await_node = node.expression();
                    // Preserve every async `return await` in the IR.  Whether
                    // its surrounding control flow has a native continuation
                    // is an emitter concern: deciding that here used only the
                    // immediate syntax parent, so valid branches and
                    // try/finally regions were rejected before the whole
                    // function could be planned.
                    Some(self.terminal_await(await_node, &ret)?)
                } else {
                    Some(self.expected_expression(node.expression(), ret.clone())?)
                };
                let value = match value {
                    Some(value)
                        if value.ty() != ret
                            && matches!(value.ty(), Type::Record { .. })
                            && matches!(ret, Type::Record { .. }) =>
                    {
                        // A JavaScript literal may retain the owning layout
                        // of a nested mutable record. At a declared function
                        // boundary, project the existing shared store rather
                        // than returning a different ABI or copying fields.
                        Some(self.coerce(value, ret.clone(), node.expression())?)
                    }
                    value => value,
                };
                let actual = value.as_ref().map_or(Type::Void, Expr::ty);
                if actual != ret {
                    return Err(self.refuse(
                        node,
                        &format!(
                            "return coercion is not ported: lowered {actual:?}, expected {ret:?}"
                        ),
                    ));
                }
                Stmt::Return { value, loc }
            }
            SyntaxKind::EmptyStatement
            | SyntaxKind::InterfaceDeclaration
            | SyntaxKind::JsTypeAliasDeclaration
            | SyntaxKind::TypeAliasDeclaration => return Ok(vec![]),
            SyntaxKind::ModuleDeclaration
                if node.modifier_flags().intersects(ModifierFlags::AMBIENT) =>
            {
                return Ok(vec![]);
            }
            SyntaxKind::Block => {
                let mut body = self.hoist_forward_closures(node)?;
                body.extend(self.statements(node.statements())?);
                Stmt::Block { body, loc }
            }
            SyntaxKind::VariableStatement | SyntaxKind::VariableDeclarationList => {
                let list = if node.kind() == SyntaxKind::VariableDeclarationList {
                    node
                } else {
                    node.declaration_list()
                };
                let flags = list.flags();
                if !flags.intersects(NodeFlags::LET | NodeFlags::CONST) {
                    return self.var_statement(node);
                }
                if node.modifier_flags().intersects(ModifierFlags::AMBIENT) {
                    // Bundlers commonly inject declared build constants. In a
                    // standalone native binary no host binding exists, so the
                    // JavaScript-observable value is absent: `typeof NAME`
                    // must be "undefined" and guarded fallback branches must
                    // remain usable. Materialize one undefined module cell;
                    // builds may later override it through an explicit define
                    // surface without changing the IR binding identity.
                    let mut out = Vec::new();
                    for declaration in list.declarations().nodes() {
                        let name = declaration.name();
                        if name.kind() != SyntaxKind::Identifier {
                            return Err(self.refuse(
                                declaration,
                                "ambient destructuring declarations are not ported",
                            ));
                        }
                        let symbol = self.symbol(name);
                        let local = if let Some(local) = self.module_bindings.get(&symbol) {
                            local.clone()
                        } else {
                            let value_type = self.storage_type(name)?;
                            let storage =
                                self.undefined_storage_type(value_type.clone(), declaration)?;
                            self.module_vars.insert(symbol, value_type.clone());
                            self.var_types.insert(symbol, value_type);
                            self.module_binding(name, storage, false)
                        };
                        out.push(Stmt::Assign {
                            local_id: local.id,
                            initializes_global: true,
                            value: self.var_undefined(local.r#type, declaration)?,
                            loc: self.loc(declaration),
                        });
                    }
                    return Ok(out);
                }
                let mut out = Vec::new();
                for declaration in list.declarations().nodes() {
                    let name = declaration.name();
                    if self
                        .commonjs
                        .native_declarations
                        .contains(&declarations::Key::of(declaration))
                    {
                        if name.kind() == SyntaxKind::ObjectBindingPattern {
                            let mut fields = Vec::new();
                            for element in name.elements() {
                                if element.kind() != SyntaxKind::BindingElement
                                    || !element.dot_dot_dot_token().is_nil()
                                    || !matches!(
                                        element.name().kind(),
                                        SyntaxKind::Identifier | SyntaxKind::ObjectBindingPattern
                                    )
                                {
                                    return Err(self.refuse(
                                        element,
                                        "native require bindings need named non-rest object members",
                                    ));
                                }
                                let key = element.property_name_or_name().text().to_owned();
                                let value = self.native_require_pattern_value(element.name())?;
                                fields.push(ir::DynamicField {
                                    key: Expr::StrLit {
                                        value: key,
                                        r#type: Type::String,
                                        loc: self.loc(element),
                                    },
                                    value,
                                });
                            }
                            let init = Expr::DynObjLit {
                                fields,
                                r#type: Type::Dyn,
                                loc: self.loc(declaration.initializer()),
                            };
                            out.extend(self.object_binding_value(
                                name,
                                init,
                                !flags.intersects(NodeFlags::CONST),
                                node.parent().kind() == SyntaxKind::SourceFile,
                                declaration,
                            )?);
                        }
                        continue;
                    }
                    let symbol = self.symbol(name);
                    if self.native_namespaces.contains_key(&symbol) {
                        continue;
                    }
                    if name.kind() == SyntaxKind::ArrayBindingPattern {
                        out.extend(self.array_binding_declaration(
                            declaration,
                            !flags.intersects(NodeFlags::CONST),
                            node.parent().kind() == SyntaxKind::SourceFile,
                        )?);
                        continue;
                    }
                    if name.kind() == SyntaxKind::ObjectBindingPattern {
                        out.extend(self.object_binding_declaration(
                            declaration,
                            !flags.intersects(NodeFlags::CONST),
                            node.parent().kind() == SyntaxKind::SourceFile,
                        )?);
                        continue;
                    }
                    if name.kind() != SyntaxKind::Identifier {
                        return Err(self
                            .refuse(declaration, "identifier lexical declarations are required"));
                    }
                    if let Some(forward) = self.initialize_forward_closure(declaration, flags)? {
                        out.extend(forward);
                        continue;
                    }
                    if let Some(recursive) = self.recursive_const_closure(
                        declaration,
                        flags,
                        node.parent().kind() == SyntaxKind::SourceFile,
                    )? {
                        out.extend(recursive);
                        continue;
                    }
                    // Split a direct awaited string-method initializer into a
                    // suspension and a post-resume lexical initialization.
                    if !declaration.initializer().is_nil() {
                        let initializer = primitives::primitive_source(declaration.initializer());
                        if initializer.kind() == SyntaxKind::CallExpression
                            && initializer.arguments().is_empty()
                        {
                            let member = primitives::primitive_source(initializer.expression());
                            if member.kind() == SyntaxKind::PropertyAccessExpression
                                && member.question_dot_token().is_nil()
                            {
                                let awaited_node =
                                    primitives::primitive_source(member.expression());
                                let method = member.name().text();
                                let method_symbol = self.symbol(member.name());
                                if awaited_node.kind() == SyntaxKind::AwaitExpression
                                    && matches!(
                                        method,
                                        "trim"
                                            | "trimStart"
                                            | "trimEnd"
                                            | "toLowerCase"
                                            | "toUpperCase"
                                    )
                                    && (self.primitive_symbol(
                                        method_symbol,
                                        method,
                                        Some("String"),
                                    ) || method_symbol == 0)
                                    && self.simple_await_declaration(declaration)
                                    && self.storage_type(name)? == Type::String
                                {
                                    let awaited =
                                        self.terminal_await(awaited_node, &Type::String)?;
                                    let resumed = self.construction_local(Type::String, false);
                                    let local = Local {
                                        id: format!("v{}", self.locals.len()),
                                        name: name.text().into(),
                                        r#type: Type::String,
                                        mutable: !flags.intersects(NodeFlags::CONST),
                                        boxed: false,
                                    };
                                    self.bindings.insert(symbol, local.clone());
                                    self.locals.push(local.clone());
                                    out.push(Stmt::VarDecl {
                                        local_id: resumed.id.clone(),
                                        init: awaited,
                                        loc: self.loc(awaited_node),
                                    });
                                    out.push(Stmt::VarDecl {
                                        local_id: local.id,
                                        init: Expr::StringIntrinsic {
                                            method: method.into(),
                                            receiver: Box::new(
                                                self.construction_read(&resumed, awaited_node),
                                            ),
                                            args: vec![],
                                            r#type: Type::String,
                                            loc: self.loc(initializer),
                                        },
                                        loc: self.loc(declaration),
                                    });
                                    continue;
                                }
                            }
                        }
                    }
                    let initializer = declaration.initializer();
                    let dynamic_native_namespace = if !initializer.is_nil()
                        && initializer.kind() == SyntaxKind::AwaitExpression
                    {
                        let call = initializer.expression();
                        if call.kind() == SyntaxKind::CallExpression
                            && call.expression().kind() == SyntaxKind::ImportKeyword
                            && call.arguments().len() == 1
                        {
                            let specifier = call.arguments().get(0);
                            let module = self
                                .static_builtin_import_specifier(specifier)
                                .and_then(|literal| builtins::module(literal.text()));
                            if let Some(module) = module
                                && specifier.kind() == SyntaxKind::Identifier
                            {
                                self.validate_constant_builtin_namespace(
                                    declaration,
                                    name,
                                    module,
                                )?;
                            }
                            module
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    if let Some(module) = dynamic_native_namespace {
                        self.bind_native_namespace(name, module);
                    }
                    let tls_peer_value =
                        !initializer.is_nil() && self.tls_peer_certificate_call(initializer);
                    let json_owned_result =
                        !initializer.is_nil() && self.json_stringify_result(initializer);
                    let owning_function_result =
                        !initializer.is_nil() && self.owning_function_result_call(initializer);
                    let descriptor_owned_result =
                        !initializer.is_nil() && self.object_descriptor_result(initializer);
                    let nonnull_array_element = self.inferred_nonnull_array_element(declaration);
                    let nonnull_array_removal = self.inferred_nonnull_array_removal(declaration);
                    let storage = if nonnull_array_element
                        || nonnull_array_removal
                        || tls_peer_value
                        || dynamic_native_namespace.is_some()
                        || json_owned_result
                        || owning_function_result
                        || (!initializer.is_nil()
                            && (self.native_dynamic_result_call(initializer)
                                || self.native_computed_symbol_result_call(initializer)
                                || self.timer_optional_method_value(initializer)))
                    {
                        Ok(Type::Dyn)
                    } else {
                        self.storage_type(name)
                    };
                    let storage = if self.contextual_empty_object_is_open(declaration, &storage) {
                        Ok(Type::Dyn)
                    } else {
                        storage
                    };
                    // Type assertions and non-null assertions disappear at
                    // runtime. Inspect the underlying indexed source so an
                    // inferred local retains an actual undefined result.
                    let source_initializer = if declaration.initializer().is_nil() {
                        declaration.initializer()
                    } else {
                        primitives::primitive_source(declaration.initializer())
                    };
                    if std::env::var_os("SCRIPTC_TRACE_RECORD_VIEWS").is_some()
                        && !source_initializer.is_nil()
                        && source_initializer.kind() == SyntaxKind::CallExpression
                    {
                        eprintln!(
                            "scriptc: local-record-view name={} js={} flags={:?} source={:?} storage={:?} declared={:?} annotationNil={}",
                            name.text(),
                            parameter_abi::is_javascript(declaration),
                            flags,
                            source_initializer.kind(),
                            storage.as_ref().ok(),
                            self.declared(declaration),
                            declaration.type_().is_nil(),
                        );
                    }
                    let assertion_source = if !initializer.is_nil() {
                        let file = get_source_file_of_node(declaration);
                        let text = source_file_text(file);
                        let start = get_token_pos_of_node(declaration, file, false).max(0) as usize;
                        let end = declaration.end().max(0) as usize;
                        text.get(start..end).map(str::to_owned)
                    } else {
                        None
                    };
                    let open_record_assertion = assertion_source.as_deref().is_some_and(|source| {
                        source.contains(" as Record<") || source.contains("<Record<")
                    });
                    let namespace_index_snapshot =
                        if open_record_assertion && !source_initializer.is_nil() {
                            self.namespace_index_snapshot(source_initializer)?
                        } else {
                            None
                        };
                    let (mut ty, init) = if declaration.initializer().is_nil() {
                        let value_type = storage?;
                        let ty = self.undefined_storage_type(value_type.clone(), declaration)?;
                        self.var_types.insert(symbol, value_type);
                        self.var_defined.remove(&symbol);
                        let init = self.coerce(
                            Expr::UnitLit {
                                unit: "undefined",
                                r#type: Type::Undefined,
                                loc: self.loc(declaration),
                            },
                            ty.clone(),
                            declaration,
                        )?;
                        (ty, init)
                    } else if self
                        .symbol_initializer_storage(source_initializer)
                        .is_some()
                    {
                        let init = self.expression(source_initializer)?;
                        (Type::Symbol, init)
                    } else if dynamic_native_namespace.is_some() {
                        let init = self.expected_expression(initializer, Type::Dyn)?;
                        (Type::Dyn, init)
                    } else if self.native_weak_reference_constructor(source_initializer) {
                        // Weak references are represented by opaque NativeValue
                        // owners. The checker exposes structural WeakRef and
                        // FinalizationRegistry interfaces that must not be
                        // projected into closed record layouts.
                        let init = self.expression(source_initializer)?;
                        let init = self.coerce(init, Type::Dyn, source_initializer)?;
                        self.native_dynamic_values.insert(symbol);
                        (Type::Dyn, init)
                    } else if nonnull_array_removal {
                        let init = self.expression(source_initializer)?;
                        let init = self.coerce(init, Type::Dyn, source_initializer)?;
                        self.var_types.insert(symbol, Type::Dyn);
                        self.var_defined.remove(&symbol);
                        self.native_dynamic_values.insert(symbol);
                        (Type::Dyn, init)
                    } else if nonnull_array_element {
                        let init = self.expression(source_initializer)?;
                        let init = match init {
                            Expr::DynCheck { value, .. }
                                if matches!(value.as_ref(), Expr::DynKeyGet { .. }) =>
                            {
                                *value
                            }
                            value @ Expr::DynKeyGet { .. } => value,
                            init => self
                                .raw_array_element(&init, source_initializer)
                                .ok_or_else(|| {
                                    self.refuse(
                                        source_initializer,
                                        "asserted array element requires an owning dynamic value",
                                    )
                                })?,
                        };
                        self.var_types.insert(symbol, Type::Dyn);
                        self.var_defined.remove(&symbol);
                        self.native_dynamic_values.insert(symbol);
                        (Type::Dyn, init)
                    } else if descriptor_owned_result {
                        let init = self.expression(source_initializer)?;
                        let init = match init {
                            Expr::DynCheck { value, .. } if matches!(value.as_ref(), Expr::LibCall { r#fn, .. } if r#fn == "dyn.getOwnPropertyDescriptor") => {
                                *value
                            }
                            init => init,
                        };
                        let init = self.coerce(init, Type::Dyn, source_initializer)?;
                        self.native_dynamic_values.insert(symbol);
                        (Type::Dyn, init)
                    } else if tls_peer_value {
                        let init = self.expression(source_initializer)?;
                        let init = self.coerce(init, Type::Dyn, source_initializer)?;
                        self.native_dynamic_values.insert(symbol);
                        (Type::Dyn, init)
                    } else if json_owned_result || owning_function_result {
                        // The function can return an owning value even when
                        // its declaration projects away undefined. Retain
                        // that value until the consumer observes it.
                        let init = self.expression(source_initializer)?;
                        let init = self.coerce(init, Type::Dyn, source_initializer)?;
                        self.var_types.insert(symbol, Type::Dyn);
                        self.var_defined.remove(&symbol);
                        self.native_dynamic_values.insert(symbol);
                        (Type::Dyn, init)
                    } else if self.native_computed_symbol_result_call(source_initializer)
                        || self.timer_optional_method_value(source_initializer)
                    {
                        // A computed protocol call returns a NativeValue owner.
                        // Checker declarations may describe it as Generator,
                        // but projecting that erased iterator into a compiled
                        // generator handle would lose its runtime identity.
                        let init = self.expression(source_initializer)?;
                        let init = self.coerce(init, Type::Dyn, source_initializer)?;
                        self.native_dynamic_values.insert(symbol);
                        (Type::Dyn, init)
                    } else if self.native_dynamic_result_call(source_initializer) {
                        // The manifest owns this erased result contract. Keep
                        // the runtime NativeValue instead of projecting it into
                        // a declaration-only callable record (for example
                        // util.debuglog's callable plus `.enabled` surface).
                        let (module, member) = self
                            .native_dynamic_result_binding(source_initializer)
                            .expect("checked native dynamic binding");
                        let init = self.native_call(source_initializer, module, &member)?;
                        let init = self.coerce(init, Type::Dyn, source_initializer)?;
                        self.native_dynamic_values.insert(symbol);
                        (Type::Dyn, init)
                    } else if let Some(init) =
                        self.stored_map_keys_initializer(source_initializer)?
                    {
                        // Newer lib.d.ts revisions expose MapIterator as a
                        // large structural helper interface. The native owner
                        // is deliberately the compact stateful key snapshot,
                        // not a copied record projection of that interface.
                        self.var_types.insert(symbol, init.ty());
                        self.var_defined.remove(&symbol);
                        (init.ty(), init)
                    } else if self.is_proxy_new(source_initializer) {
                        let init = self.expression(source_initializer)?;
                        (Type::Dyn, init)
                    } else if let Some(init) = namespace_index_snapshot {
                        self.var_types.insert(symbol, Type::Dyn);
                        self.var_defined.remove(&symbol);
                        (Type::Dyn, init)
                    } else if declaration.type_().is_nil()
                        && matches!(
                            source_initializer.kind(),
                            SyntaxKind::NewExpression | SyntaxKind::Identifier
                        )
                        && storage
                            .as_ref()
                            .is_ok_and(|ty| matches!(ty, Type::Record { .. }))
                    {
                        // A declaration-backed class factory can make the
                        // checker expose `new Constructor()` as a structural
                        // interface even though lowering has recovered the
                        // concrete native class. An unannotated local owns that
                        // instance; aliases must keep the same owner rather
                        // than copying it into the public record projection.
                        let projected = storage?;
                        let init = self.expression(source_initializer)?;
                        if matches!(init.ty(), Type::Object { .. }) {
                            (init.ty(), init)
                        } else {
                            let init = self.coerce(init, projected.clone(), source_initializer)?;
                            (projected, init)
                        }
                    } else if flags.intersects(NodeFlags::CONST)
                        && node.parent().kind() != SyntaxKind::SourceFile
                        && declaration.type_().is_nil()
                        && self.child_projected_type(source_initializer) == Some(Type::Child)
                    {
                        let init = self.expression(declaration.initializer())?;
                        (Type::Child, init)
                    } else if open_record_assertion
                        && self.declared(declaration).is_none()
                        && declaration.type_().is_nil()
                    {
                        let init = self.expression(source_initializer)?;
                        let init = self.coerce(init, Type::Dyn, source_initializer)?;
                        self.var_types.insert(symbol, Type::Dyn);
                        self.var_defined.remove(&symbol);
                        (Type::Dyn, init)
                    } else if storage.is_err()
                        && ((declaration.type_().is_nil() && self.declared(declaration).is_none())
                            || (flags.intersects(NodeFlags::CONST)
                                && parameter_abi::is_javascript(declaration)
                                && matches!(
                                    source_initializer.kind(),
                                    SyntaxKind::ObjectLiteralExpression
                                        | SyntaxKind::ArrayLiteralExpression
                                )))
                    {
                        let init = self.expression(declaration.initializer())?;
                        if matches!(init.ty(), Type::Void | Type::Null | Type::Undefined) {
                            return Err(
                                self.refuse(declaration, "initializer has no native storage type")
                            );
                        }
                        (init.ty(), init)
                    } else if flags.intersects(NodeFlags::CONST)
                        && parameter_abi::is_javascript(declaration)
                        && declaration.type_().is_nil()
                        && source_initializer.kind() == SyntaxKind::ObjectLiteralExpression
                        && storage
                            .as_ref()
                            .is_ok_and(|ty| matches!(ty, Type::Record { .. }))
                    {
                        let inferred = storage?;
                        let init = self.expression(declaration.initializer())?;
                        if self.call_record_storage(&init.ty(), &inferred) {
                            (init.ty(), init)
                        } else {
                            let init =
                                self.coerce(init, inferred.clone(), declaration.initializer())?;
                            (inferred, init)
                        }
                    } else if flags.intersects(NodeFlags::CONST)
                        && parameter_abi::is_javascript(declaration)
                        && declaration.type_().is_nil()
                        && matches!(
                            source_initializer.kind(),
                            SyntaxKind::CallExpression | SyntaxKind::PropertyAccessExpression
                        )
                        && storage.as_ref().is_ok_and(|ty| *ty == Type::Dyn)
                    {
                        let init = self.expression(declaration.initializer())?;
                        let checked_dynamic = self.ty(source_initializer).ok() == Some(Type::Dyn);
                        if !checked_dynamic
                            && init.ty() != Type::Dyn
                            && self.dynamic_erasure_reason(&init.ty()).is_none()
                        {
                            (init.ty(), init)
                        } else {
                            let init = self.coerce(init, Type::Dyn, declaration.initializer())?;
                            (Type::Dyn, init)
                        }
                    } else if flags.intersects(NodeFlags::CONST)
                        && parameter_abi::is_javascript(declaration)
                        && declaration.type_().is_nil()
                        && matches!(
                            source_initializer.kind(),
                            SyntaxKind::CallExpression | SyntaxKind::PropertyAccessExpression
                        )
                        && storage
                            .as_ref()
                            .is_ok_and(|ty| matches!(ty, Type::Union { .. }))
                    {
                        // A checked JavaScript facade can attach a structural
                        // union projection to an unannotated call/property
                        // local even though the producer publishes one concrete
                        // shared record ABI. Preserve that producer storage
                        // rather than manufacturing an ambiguous union tag.
                        let inferred = storage?;
                        let init = self.expression(declaration.initializer())?;
                        if self.call_record_storage(&init.ty(), &inferred) {
                            (init.ty(), init)
                        } else {
                            let init =
                                self.coerce(init, inferred.clone(), declaration.initializer())?;
                            (inferred, init)
                        }
                    } else if self.bun_ffi_dlopen_call(source_initializer) {
                        // The declaration-file return is an open Bun FFI
                        // object. This supported descriptor owns a compact
                        // native console token instead of a structural copy.
                        let init = self.expression(declaration.initializer())?;
                        (init.ty(), init)
                    } else if self.bun_ffi_kernel_call(source_initializer) {
                        // Pointer and result values from the translated facade
                        // retain the compact native representation selected by
                        // the call instead of declaration-file pointer records.
                        let init = self.expression(declaration.initializer())?;
                        (init.ty(), init)
                    } else if self.javascript_prototype_value_candidate(source_initializer) {
                        let init = self.expression(declaration.initializer())?;
                        if init.ty() == Type::Dyn {
                            self.var_types.insert(symbol, Type::Dyn);
                            self.var_defined.remove(&symbol);
                            (Type::Dyn, init)
                        } else {
                            let ty = storage?;
                            let init = self.coerce(init, ty.clone(), declaration.initializer())?;
                            (ty, init)
                        }
                    } else if self.dynamic_callable_initializer(source_initializer) {
                        let init = self.expression(declaration.initializer())?;
                        if init.ty() == Type::Dyn {
                            // Function.call/apply can return any JavaScript
                            // value despite a declaration-only result type.
                            // The binding owns that value until a real typed
                            // consumer requires a projection.
                            self.var_types.insert(symbol, Type::Dyn);
                            self.var_defined.remove(&symbol);
                            (Type::Dyn, init)
                        } else {
                            let ty = storage?;
                            let init = self.coerce(init, ty.clone(), declaration.initializer())?;
                            (ty, init)
                        }
                    } else if self.inferred_call_local(declaration, node, flags) {
                        let inferred = storage?;
                        let init = if self.planned_local_storage.get(&symbol) == Some(&inferred)
                            && declaration.initializer().kind() == SyntaxKind::CallExpression
                        {
                            // A later represented consumer (for example a
                            // class-field array push) can establish the owning
                            // ABI for an otherwise erased JavaScript call.
                            // Feed that context into the producer before its
                            // method/function result contract is frozen.
                            self.expected_expression(declaration.initializer(), inferred.clone())?
                        } else {
                            self.expression(declaration.initializer())?
                        };
                        let concrete_erased_call = inferred == Type::Dyn
                            && self.ty(declaration.initializer()).ok() != Some(Type::Dyn)
                            && init.ty() != Type::Dyn
                            && self.dynamic_erasure_reason(&init.ty()).is_none();
                        let ty = if self.call_record_storage(&init.ty(), &inferred)
                            || concrete_erased_call
                        {
                            init.ty()
                        } else {
                            inferred.clone()
                        };
                        let init = self.coerce(init, ty.clone(), declaration.initializer())?;
                        (ty, init)
                    } else if self.declared(declaration).is_none()
                        && declaration.type_().is_nil()
                        && matches!(
                            source_initializer.kind(),
                            SyntaxKind::PropertyAccessExpression
                                | SyntaxKind::ElementAccessExpression
                        )
                    {
                        let init = self.expression(source_initializer)?;
                        if matches!(init, Expr::RecordKeyGet { .. })
                            || (source_initializer.kind() == SyntaxKind::ElementAccessExpression
                                && (init.ty() == Type::Dyn || self.optional_storage(&init.ty())))
                        {
                            // An inferred slot retains an index lookup's actual
                            // owning ABI (including dynamic/undefined), even if
                            // the checker projects a different flow type.
                            self.var_types.insert(symbol, init.ty());
                            self.var_defined.remove(&symbol);
                            (init.ty(), init)
                        } else {
                            let ty = storage?;
                            let init = self.coerce(init, ty.clone(), declaration.initializer())?;
                            (ty, init)
                        }
                    } else {
                        let ty = storage?;
                        let init =
                            self.expected_expression(declaration.initializer(), ty.clone())?;
                        (ty, init)
                    };
                    if ty != init.ty() && self.indexed_json_union_views(&init.ty(), &ty) {
                        // A declaration view may re-intern the same recursive
                        // JSON graph. The local owns the initializer's tags;
                        // consumers retain their checker view independently.
                        ty = init.ty();
                    }
                    if ty != init.ty()
                        && parameter_abi::is_javascript(declaration)
                        && self.call_record_storage(&init.ty(), &ty)
                    {
                        // A JSDoc view can declare the post-initialization
                        // object type while the literal owns a real nullish
                        // sentinel. Keep that owning record ABI in the local;
                        // typed consumers use the ordinary checked view.
                        ty = init.ty();
                    }
                    if ty != init.ty() {
                        return Err(self.refuse(
                            declaration,
                            &format!(
                                "declaration coercion is not ported: initializer {:?}, storage {ty:?}",
                                init.ty()
                            ),
                        ));
                    }
                    if self.presence_storage(&ty) {
                        self.var_types.entry(symbol).or_insert_with(|| ty.clone());
                    }
                    if self.var_types.contains_key(&symbol) {
                        self.var_assignment_fact(symbol, &init);
                    }
                    if node.parent().kind() == SyntaxKind::SourceFile {
                        let binding =
                            self.module_binding(name, ty, !flags.intersects(NodeFlags::CONST));
                        let init = if binding.r#type == init.ty() {
                            init
                        } else {
                            // Module inventory can preserve a concrete checker
                            // record while `as const satisfies` lowers through
                            // Dyn. Publish a checked view into the predeclared
                            // cell without copying or changing object identity.
                            self.coerce(init, binding.r#type.clone(), declaration.initializer())?
                        };
                        if binding.r#type != init.ty() {
                            let binding_layout = match &binding.r#type {
                                Type::Record { shape_id } => {
                                    format!("{:?}", self.records[*shape_id])
                                }
                                ty => format!("{ty:?}"),
                            };
                            let initializer_type = init.ty();
                            let initializer_layout = match &initializer_type {
                                Type::Record { shape_id } => {
                                    format!("{:?}", self.records[*shape_id])
                                }
                                ty => format!("{ty:?}"),
                            };
                            return Err(self.refuse(
                                declaration,
                                &format!(
                                    "module binding layout {binding_layout} differs from initializer {initializer_layout}"
                                ),
                            ));
                        }
                        out.push(Stmt::Assign {
                            local_id: binding.id,
                            initializes_global: true,
                            value: init,
                            loc: self.loc(declaration),
                        });
                        continue;
                    }
                    let local = Local {
                        id: format!("v{}", self.locals.len()),
                        name: name.text().into(),
                        r#type: ty,
                        mutable: !flags.intersects(NodeFlags::CONST),
                        boxed: false,
                    };
                    let symbol = self.checker.get_symbol_at_location(name, false);
                    self.bindings.insert(symbol.0, local.clone());
                    self.locals.push(local.clone());
                    out.push(Stmt::VarDecl {
                        local_id: local.id,
                        init,
                        loc: self.loc(declaration),
                    });
                }
                return Ok(out);
            }
            SyntaxKind::ExpressionStatement
                if node.expression().kind() == SyntaxKind::AwaitExpression
                    && (self.protected_linear_body(node.parent()) || self.is_async_function) =>
            {
                let awaited = node.expression();
                let awaited_type = self.checker.get_type_at_location(awaited);
                let never = self.checker.ty(awaited_type).flags.intersects(TypeFlags::NEVER);
                let result = match self.ty(awaited) {
                    Ok(result) => result,
                    // `await rejectOnly()` has type `never`; resume with the
                    // Promise<never> payload ABI. No fulfilled value exists.
                    Err(_) if never => Type::Void,
                    Err(_) if self.standard_promise_all_call(awaited.expression()) => Type::Dyn,
                    Err(error) => return Err(error),
                };
                Stmt::Expression {
                    expr: self.terminal_await(awaited, &result)?,
                    loc,
                }
            }
            SyntaxKind::ExpressionStatement => self.effect_statement(node.expression(), node)?,
            SyntaxKind::IfStatement => self.var_if(node)?,
            _ => return Err(self.refuse(node, "statement is not ported")),
        };
        Ok(vec![stmt])
    }
    pub(super) fn effect_statement(
        &mut self,
        expression: Node,
        node: Node,
    ) -> Result<Stmt, String> {
        let loc = self.loc(node);
        Ok(
            if expression.kind() == SyntaxKind::BinaryExpression
                && expression.operator_token().kind() == SyntaxKind::EqualsToken
            {
                if let Some(stmt) = self.process_env_assignment(expression)? {
                    return Ok(stmt);
                }
                if let Some(stmt) = self.process_exit_code_assignment(expression)? {
                    return Ok(stmt);
                }
                if expression.left().kind() == SyntaxKind::ElementAccessExpression {
                    return self.dictionary_set(expression);
                }
                if primitives::primitive_source(expression.left()).kind()
                    == SyntaxKind::ArrayLiteralExpression
                {
                    return Ok(Stmt::Expression {
                        expr: self.array_assignment_expression(expression)?,
                        loc,
                    });
                }
                if expression.left().kind() == SyntaxKind::PropertyAccessExpression {
                    if let Some(stmt) = self.class_prototype_data_set(expression)? {
                        return Ok(stmt);
                    }
                    if let Some(value) = self.regex_set(expression)? {
                        return Ok(value);
                    }
                    if let Some(stmt) = self.class_set(expression)? {
                        return Ok(stmt);
                    }
                    return self.record_set(expression);
                }
                if expression.left().kind() != SyntaxKind::Identifier {
                    return Err(self.refuse(expression, "only local assignment is ported"));
                }
                if self.enum_type(expression.left()).is_some() {
                    return Err(
                        self.refuse(expression, "enum namespace reassignment is not ported")
                    );
                }
                let symbol = self.symbol(expression.left());
                if self.native_namespaces.contains_key(&symbol) {
                    return Err(self.refuse(
                        expression,
                        "native namespace alias reassignment is not ported",
                    ));
                }
                let local = self.binding(expression.left())?;
                if !local.mutable {
                    return Err(self.refuse(
                        expression,
                        &format!(
                            "assignment to an immutable binding is not ported ({} {}, {:?})",
                            local.id, local.name, local.r#type
                        ),
                    ));
                }
                if local.r#type == Type::Caught || self.caught_aliases.contains_key(&symbol) {
                    return Err(self.refuse(expression, "catch binding reassignment is not ported"));
                }
                let symbol = self.symbol(expression.left());
                let target = if self.absence_assignments.contains(&symbol) {
                    local.r#type.clone()
                } else {
                    self.var_types
                        .get(&symbol)
                        .cloned()
                        .unwrap_or_else(|| local.r#type.clone())
                };
                let value = self.expected_expression(expression.right(), target)?;
                let value = self.coerce(value, local.r#type.clone(), expression)?;
                let value = self
                    .class_capture_assignment(symbol, value.clone(), expression)
                    .unwrap_or(value);
                if self.var_types.contains_key(&symbol) {
                    self.var_assignment_fact(symbol, &value);
                }
                Stmt::Assign {
                    local_id: local.id,
                    initializes_global: false,
                    value,
                    loc,
                }
            } else {
                let expr = self.expression(expression)?;
                if matches!(expr.ty(), Type::Null | Type::Undefined)
                    && !matches!(expr, Expr::YieldStar { .. })
                {
                    return Err(
                        self.refuse(expression, "standalone unit expressions are not ported")
                    );
                }
                Stmt::Expression { expr, loc }
            },
        )
    }
    fn expression(&mut self, node: Node) -> Result<Expr, String> {
        if node.is_nil() {
            return Err("SCN9001: frontend received an absent expression node".into());
        }
        if std::env::var("SCRIPTC_TRACE_EXPRESSIONS")
            .is_ok_and(|filter| filter == "1" || self.file.replace('\\', "/").contains(&filter))
        {
            eprintln!(
                "scriptc: lowering expression {:?} at {}:{}..{}",
                node.kind(),
                self.file,
                node.pos(),
                node.end()
            );
        }
        let value = self.expression_inner(node).and_then(|value| {
            // A discarded value needs no checker projection: inserting a
            // dynamic type check here can throw after a successful JS call.
            let mut consumer = node.parent();
            while matches!(
                consumer.kind(),
                SyntaxKind::ParenthesizedExpression
                    | SyntaxKind::AsExpression
                    | SyntaxKind::TypeAssertionExpression
                    | SyntaxKind::SatisfiesExpression
                    | SyntaxKind::NonNullExpression
            ) {
                consumer = consumer.parent();
            }
            let live_dynamic_callee = consumer.kind() == SyntaxKind::CallExpression
                && consumer.expression() == node
                && (matches!(&value, Expr::FieldGet { r#type: Type::Dyn, .. })
                    || matches!(&value, Expr::DynFrom { value: field, .. }
                        if matches!(field.as_ref(), Expr::FieldGet { .. })
                            && matches!(field.ty(), Type::Union { union_id }
                                if self.unions[union_id].arms.iter().any(|arm| matches!(arm, Type::Func { .. })))));
            let ambient_fetch_call = node.kind() == SyntaxKind::CallExpression
                && node.expression().kind() == SyntaxKind::Identifier
                && node.expression().text() == "fetch"
                && {
                    let symbol = self.symbol(node.expression());
                    !self.bindings.contains_key(&symbol)
                        && !self.module_bindings.contains_key(&symbol)
                        && !self.outer.iter().any(|scope| scope.contains_key(&symbol))
                };
            // Expr::Call carries the compiler-owned ABI of a known source
            // function. If that ABI is deliberately erased, a checker's
            // inferred view of an unchecked JavaScript body must not silently
            // replace it (for example a generic .d.ts contract beside a JS
            // class field initially inferred as undefined). Explicit expected
            // contexts still install a checked view through expected_expression.
            let erased_registered_call =
                matches!(&value, Expr::Call { r#type: Type::Dyn, .. });
            let erased_callable_call = matches!(&value, Expr::CallValue { r#type: Type::Dyn, .. });
            let owning_dynamic_call = matches!(&value, Expr::DynCall { r#type: Type::Dyn, .. });
            let owning_optional_array_mutation = node.kind() == SyntaxKind::CallExpression
                && node.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
                && node.expression().kind() == SyntaxKind::PropertyAccessExpression
                && matches!(node.expression().name().text(), "push" | "unshift");
            let owning_dynamic_array_search = matches!(
                &value,
                Expr::DynInvoke { method, r#type: Type::Dyn, .. } if method == "indexOf"
            );
            let owning_dynamic_string_match = matches!(
                &value,
                Expr::DynInvoke { method, r#type: Type::Dyn, .. } if method == "match"
            );
            let owning_receiver_call = matches!(
                &value,
                Expr::DynInvoke { method, r#type: Type::Dyn, .. }
                    if matches!(method.as_str(), "call" | "apply" | "bind")
            );
            let owning_prototype_value = node.kind() == SyntaxKind::PropertyAccessExpression
                && self.javascript_prototype_value_candidate(node);
            let owning_tls_metadata = matches!(
                &value,
                Expr::DynInvoke { method, r#type: Type::Dyn, .. }
                    if matches!(method.as_str(), "getProtocol" | "getCipher" | "getPeerCertificate")
            ) && node.kind() == SyntaxKind::CallExpression
                && node.expression().kind() == SyntaxKind::PropertyAccessExpression
                && self.net_socket_type(node.expression().expression());
            if value.ty() == Type::Dyn
                && !self.bytes_named_key_value(node, &mut HashSet::new())
                && !live_dynamic_callee
                && !ambient_fetch_call
                && !erased_registered_call
                && !erased_callable_call
                && !owning_dynamic_call
                && !owning_optional_array_mutation
                && !owning_dynamic_array_search
                && !owning_dynamic_string_match
                && !owning_receiver_call
                && !owning_prototype_value
                && !owning_tls_metadata
                && !self.native_computed_symbol_result_call(node)
                && !self.timer_optional_method_value(node)
                && !self.native_reflect_dynamic_result_call(node)
                && !self.bind_intrinsic_value(node, &mut HashSet::new())
                && !(node.kind() == SyntaxKind::ElementAccessExpression
                    && self.represented_symbol_value(node.argument_expression()))
                && consumer.kind() != SyntaxKind::ExpressionStatement
                && !function_properties::owning_read(&value)
                && matches!(
                    node.kind(),
                    SyntaxKind::CallExpression
                        | SyntaxKind::PropertyAccessExpression
                        | SyntaxKind::ElementAccessExpression
                )
                && let Ok(target) = self.ty(node)
                && !matches!(
                    target,
                    Type::Dyn | Type::Null | Type::Undefined | Type::Void
                )
                && !(matches!(
                    node.kind(),
                    SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
                ) && matches!(
                    target,
                    Type::Record { .. }
                        | Type::Array { .. }
                        | Type::Map { .. }
                        | Type::Union { .. }
                ))
            {
                return self.coerce(value, target, node);
            }
            Ok(value)
        });
        if matches!(
            node.kind(),
            SyntaxKind::CallExpression | SyntaxKind::NewExpression
        ) && !matches!(&value, Ok(Expr::Intrinsic { .. } | Expr::BytesNew { .. }))
            && !matches!(&value, Ok(Expr::LibCall { r#fn, .. }) if r#fn == "buffer.alloc")
        {
            self.var_call_effects();
        }
        value
    }

    fn expression_inner(&mut self, node: Node) -> Result<Expr, String> {
        if node.kind() == SyntaxKind::DeleteExpression {
            return self.delete_expression(node);
        }
        if optional_access::is_access(node) {
            return self.optional_access(node);
        }
        if node.kind() == SyntaxKind::CallExpression
            && node.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
        {
            return self.optional_access(node);
        }
        if let Some(value) = self.dynamic_import_property(node)? {
            return Ok(value);
        }
        if let Some(value) = self.boxed_get(node)? {
            return Ok(value);
        }
        if let Some(value) = self.regex_capture_get(node)? {
            return Ok(value);
        }
        if let Some(value) = self.standard_function_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.object_prototype_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.number_predicate_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.number_parser_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.json_function_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.bun_builtin_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.child_builtin_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.native_function_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.child_property(node)? {
            return Ok(value);
        }
        if let Some(value) = self.commonjs_value(node)? {
            return Ok(value);
        }
        if let Some(value) = self.process_read(node)? {
            return Ok(value);
        }
        if let Some(value) = self.native_property_read(node) {
            return Ok(value);
        }
        if let Some(value) = self.namespace_reference(node)? {
            return Ok(value);
        }
        if let Some(value) = self.namespace_property(node)? {
            return Ok(value);
        }
        let loc = self.loc(node);
        match node.kind() {
            SyntaxKind::YieldExpression => {
                let Some(channels) = self.generator.clone() else {
                    return Err(self.refuse(node, "yield outside a represented generator"));
                };
                if !node.asterisk_token().is_nil() {
                    let source = node.expression();
                    let checked = self.ty(source).ok();
                    let contextual_array = Type::Array {
                        elem: Box::new(channels.yield_type.clone()),
                    };
                    let mut delegate = self.expression(source)?;
                    if delegate.ty() == Type::Dyn {
                        delegate = match checked {
                            Some(array @ Type::Array { .. }) => {
                                self.expected_expression(source, array)?
                            }
                            Some(Type::Dyn) if source.kind() == SyntaxKind::CallExpression => {
                                // Published JavaScript often exposes an iterable
                                // producer as `any` even though its closed-world
                                // implementation returns an array. The enclosing
                                // yield channel supplies the item ABI; retain one
                                // checked array view and delegate its live iterator.
                                self.expected_expression(source, contextual_array)?
                            }
                            _ => delegate,
                        };
                    }
                    if let Type::Array { elem } = delegate.ty() {
                        delegate = Expr::LibCall {
                            r#fn: "array.generator".into(),
                            args: vec![delegate],
                            r#type: Type::Generator {
                                r#async: false,
                                yield_type: elem,
                                return_type: Box::new(Type::Void),
                                next_type: Box::new(Type::Undefined),
                            },
                            loc: self.loc(source),
                        };
                    }
                    let delegate_type = delegate.ty();
                    let Type::Generator {
                        r#async: false,
                        yield_type,
                        return_type,
                        next_type,
                    } = delegate_type
                    else {
                        return Err(self.refuse(
                            node.expression(),
                            &format!(
                                "yield* requires a synchronous represented generator, got {delegate_type:?}"
                            ),
                        ));
                    };
                    let unit_compatible = |left: &Type, right: &Type| {
                        left == right
                            || (matches!(left, Type::Void | Type::Undefined)
                                && matches!(right, Type::Void | Type::Undefined))
                    };
                    if !(unit_compatible(&yield_type, &channels.yield_type)
                        || channels.yield_type == Type::Dyn
                        || *yield_type == Type::Dyn)
                        || !(matches!(*next_type, Type::Void | Type::Undefined)
                            || unit_compatible(&next_type, &channels.next_type))
                        || !matches!(*next_type, Type::Dyn | Type::Void | Type::Undefined)
                    {
                        return Err(self.refuse(
                            node,
                            &format!(
                                "yield* delegate channels do not match the enclosing generator (delegate yield={yield_type:?}, next={next_type:?}; outer yield={:?}, next={:?})",
                                channels.yield_type, channels.next_type
                            ),
                        ));
                    }
                    let target = self.ty(node)?;
                    let delegated_type = if unit_compatible(&return_type, &target) {
                        target.clone()
                    } else {
                        (*return_type).clone()
                    };
                    let delegated = Expr::YieldStar {
                        generator: Box::new(delegate),
                        r#type: delegated_type,
                        loc: loc.clone(),
                    };
                    let mut consumer = node.parent();
                    while matches!(
                        consumer.kind(),
                        SyntaxKind::ParenthesizedExpression
                            | SyntaxKind::AsExpression
                            | SyntaxKind::TypeAssertionExpression
                            | SyntaxKind::SatisfiesExpression
                            | SyntaxKind::NonNullExpression
                    ) {
                        consumer = consumer.parent();
                    }
                    if consumer.kind() == SyntaxKind::ExpressionStatement {
                        return Ok(delegated);
                    }
                    return self.coerce(delegated, target, node);
                }
                if node.expression().is_nil() {
                    return Err(self.refuse(node, "bare yield requires an undefined yield channel"));
                }
                let value = self.expected_expression(node.expression(), channels.yield_type)?;
                let result = if channels.next_type == Type::Undefined {
                    Type::Void
                } else {
                    channels.next_type
                };
                Ok(Expr::Yield {
                    value: Box::new(value),
                    r#type: result,
                    loc,
                })
            }
            SyntaxKind::AwaitExpression => {
                let async_generator = self.generator.is_some() && self.is_async_function;
                let simple_local = self.simple_await_local(node);
                if async_generator || simple_local || self.is_async_function {
                    // `await neverSettlesNormally()` has type `never`: the
                    // operand can only reject. Resume with the Promise<never>
                    // payload ABI (Void); no fulfilled value is observable.
                    let awaited = self.checker.get_type_at_location(node);
                    let never = self.checker.ty(awaited).flags.intersects(TypeFlags::NEVER);
                    let result = if never { Type::Void } else { self.ty(node)? };
                    if simple_local
                        && !matches!(
                            result,
                            Type::Dyn
                                | Type::F64
                                | Type::String
                                | Type::Record { .. }
                                | Type::Object { .. }
                        )
                    {
                        return Err(self.refuse(
                            node,
                            "awaited local continuation result is not representable in its native frame",
                        ));
                    }
                    self.terminal_await(node, &result)
                } else {
                    Err(self.refuse(node, "await requires a represented async function"))
                }
            }
            SyntaxKind::ClassExpression => self.class_expression(node),
            SyntaxKind::NewExpression => {
                if self.unavailable_intl_segmenter_origin(node.expression(), &mut HashSet::new()) {
                    let result_type = self.ty(node)?;
                    let stmts = node
                        .arguments()
                        .into_iter()
                        .map(|argument| {
                            Ok(Stmt::Expression {
                                expr: self.expected_expression(argument, Type::Dyn)?,
                                loc: self.loc(argument),
                            })
                        })
                        .collect::<Result<Vec<_>, String>>()?;
                    return Ok(Expr::Sequence {
                        stmts,
                        result: Box::new(Expr::Intrinsic {
                            name: "global.intlSegmenterUnavailable".into(),
                            args: vec![],
                            r#type: result_type.clone(),
                            loc: loc.clone(),
                        }),
                        r#type: result_type,
                        loc,
                    });
                }
                if self.null_object_constructor(node.expression()) {
                    if !node.arguments().is_empty() {
                        return Err(
                            self.refuse(node, "null-object constructor requires zero arguments")
                        );
                    }
                    let constructor = self.expression(node.expression())?;
                    let constructor = self.coerce(constructor, Type::Dyn, node.expression())?;
                    return Ok(Expr::Intrinsic {
                        name: "object.constructNull".into(),
                        args: vec![constructor],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if let Some(value) = self.sqlite_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.inspector_session_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.net_socket_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.crypto_hash_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.promise_new_expected(node, None)? {
                    return Ok(value);
                }
                if let Some(value) = self.proxy_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.weak_reference_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.transform_stream_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.readable_stream_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.text_decoder_stream_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.headers_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.response_new(node)? {
                    return Ok(value);
                }
                if node.expression().kind() == SyntaxKind::Identifier
                    && node.expression().text() == "Blob"
                {
                    let symbol = self.symbol(node.expression());
                    let ambient_global = !self.bindings.contains_key(&symbol)
                        && !self.module_bindings.contains_key(&symbol)
                        && !self.outer.iter().any(|scope| scope.contains_key(&symbol));
                    if ambient_global {
                        if node.arguments().len() > 2 {
                            return Err(
                                self.refuse(node, "Blob constructor accepts at most two arguments")
                            );
                        }
                        let mut args = Vec::with_capacity(2);
                        for index in 0..2 {
                            let value = if index < node.arguments().len() {
                                let argument = node.arguments().get(index);
                                self.expected_expression(argument, Type::Dyn)?
                            } else {
                                let value = Expr::UnitLit {
                                    unit: "undefined".into(),
                                    r#type: Type::Undefined,
                                    loc: loc.clone(),
                                };
                                self.coerce(value, Type::Dyn, node)?
                            };
                            args.push(value);
                        }
                        return Ok(Expr::Intrinsic {
                            name: "blob.new".into(),
                            args,
                            r#type: Type::Dyn,
                            loc,
                        });
                    }
                }
                if node.expression().kind() == SyntaxKind::Identifier
                    && node.expression().text() == "File"
                {
                    let symbol = self.symbol(node.expression());
                    let ambient_global = !self.bindings.contains_key(&symbol)
                        && !self.module_bindings.contains_key(&symbol)
                        && !self.outer.iter().any(|scope| scope.contains_key(&symbol));
                    if ambient_global {
                        if !(2..=3).contains(&node.arguments().len()) {
                            return Err(self.refuse(
                                node,
                                "File constructor requires parts, name, and optional options",
                            ));
                        }
                        let mut args = node
                            .arguments()
                            .into_iter()
                            .map(|argument| self.expected_expression(argument, Type::Dyn))
                            .collect::<Result<Vec<_>, _>>()?;
                        if args.len() == 2 {
                            let value = Expr::UnitLit {
                                unit: "undefined".into(),
                                r#type: Type::Undefined,
                                loc: loc.clone(),
                            };
                            args.push(self.coerce(value, Type::Dyn, node)?);
                        }
                        return Ok(Expr::Intrinsic {
                            name: "file.new".into(),
                            args,
                            r#type: Type::Dyn,
                            loc,
                        });
                    }
                }
                if node.expression().kind() == SyntaxKind::Identifier
                    && node.expression().text() == "WritableStream"
                {
                    let symbol = self.symbol(node.expression());
                    let ambient_global = !self.bindings.contains_key(&symbol)
                        && !self.module_bindings.contains_key(&symbol)
                        && !self.outer.iter().any(|scope| scope.contains_key(&symbol));
                    if ambient_global {
                        if node.arguments().len() > 1 {
                            return Err(self.refuse(
                                node,
                                "WritableStream constructor accepts one underlying sink",
                            ));
                        }
                        let source = if node.arguments().is_empty() {
                            let value = Expr::UnitLit {
                                unit: "undefined".into(),
                                r#type: Type::Undefined,
                                loc: loc.clone(),
                            };
                            self.coerce(value, Type::Dyn, node)?
                        } else {
                            self.expected_expression(node.arguments().get(0), Type::Dyn)?
                        };
                        return Ok(Expr::Intrinsic {
                            name: "web.writableStreamNew".into(),
                            args: vec![source],
                            r#type: Type::Dyn,
                            loc,
                        });
                    }
                }
                if node.expression().kind() == SyntaxKind::Identifier && {
                    let symbol = self.symbol(node.expression());
                    self.primitive_symbol(symbol, "Array", None)
                } {
                    return self.array_constructor_call(node);
                }
                if let Some(value) = self.date_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.array_buffer_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.data_view_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.bytes_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.codec_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.string_decoder_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.regex_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.url_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.search_params_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.abort_controller_new(node)? {
                    return Ok(value);
                }
                if self.standard_function_constructor_origin(node.expression(), &mut HashSet::new())
                {
                    return self.unsupported_function_constructor(node);
                }
                if let Ok(Type::Func { ret, .. }) = self.ty(node.expression())
                    && matches!(*ret, Type::Func { .. })
                {
                    // Function constructors that explicitly return a callable
                    // use that object as the result of `new`. Lowering the
                    // invocation through the same typed ABI preserves this
                    // standard JavaScript constructor rule without inventing
                    // a class identity for factory functions.
                    let value = self.call_value(node)?;
                    let result = self.ty(node)?;
                    return self.coerce(value, result, node);
                }
                if let Some(value) = self.class_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.dynamic_class_new(node)? {
                    return Ok(value);
                }
                match self.ty(node)? {
                    Type::Set { .. } => self.set_new(node, None),
                    Type::Map { .. } => self.map_new(node),
                    _ => Err(self.refuse(
                        node,
                        "constructor identity is not represented; dynamic construction is not ported",
                    )),
                }
            }
            SyntaxKind::ThisKeyword => self.this_expression(node),
            SyntaxKind::RegularExpressionLiteral => self.regex_literal(node),
            SyntaxKind::ElementAccessExpression => {
                if let Some(value) = self.enum_get(node)? {
                    return Ok(value);
                }
                let source = primitives::primitive_source(node.expression());
                let string_source = self.ty(source).is_ok_and(|ty| self.string_view(&ty));
                let checker_receiver = self.ty(node.expression()).ok();
                let open_dictionary_view = matches!(
                    &checker_receiver,
                    Some(Type::Record { shape_id })
                        if self.records[*shape_id].index_value.is_some()
                );
                let dynamic_identifier = node.expression().kind() == SyntaxKind::Identifier
                    && self
                        .binding(node.expression())
                        .is_ok_and(|local| local.r#type == Type::Dyn);
                let obj = if string_source {
                    self.primitive_operand(node.expression())?
                } else if dynamic_identifier
                    || (open_dictionary_view && node.expression().kind() == SyntaxKind::Identifier)
                {
                    self.condition_value(node.expression())?
                } else {
                    self.expression(node.expression())?
                };
                let obj = self.live_member_receiver(node.expression(), obj);
                let represented_symbol_key =
                    self.represented_symbol_value(node.argument_expression());
                if represented_symbol_key
                    && matches!(obj.ty(), Type::Object { .. } | Type::Union { .. })
                {
                    // Unique-symbol slots are an owning expando surface. In
                    // checked JavaScript, flow projections for distinct symbol
                    // keys can be merged; do not narrow one slot through a
                    // sibling's function/record type before its use context.
                    let obj = self.coerce(obj, Type::Dyn, node.expression())?;
                    let key = self.dynamic_read_key_expression(node.argument_expression())?;
                    return Ok(self.dynamic_get(node, obj, key));
                }
                if let Some(checker_view @ Type::Record { .. }) = checker_receiver
                    && open_dictionary_view
                    && !dynamic_identifier
                    && obj.ty() != checker_view
                {
                    // A structural `Record<string, unknown>` assertion is a
                    // dictionary view over the owning JavaScript value, not a
                    // request to rebuild heterogeneous storage as one closed
                    // Rust record. Dynamic lookup retains array/record
                    // identity and the ordinary null/undefined TypeError.
                    let obj = self.coerce(obj, Type::Dyn, node.expression())?;
                    let key = self.dynamic_read_key_expression(node.argument_expression())?;
                    let value = self.dynamic_get(node, obj, key);
                    let result = self.ty(node)?;
                    return self.coerce(value, result, node);
                }
                if self.is_data_view(&obj.ty()) {
                    return Err(self.refuse(node, "computed DataView properties are not ported"));
                }
                if self.string_view(&obj.ty()) {
                    return self.string_index(node, obj);
                }
                if self.array_view(&obj.ty())
                    && self
                        .literal_property_key(node.argument_expression())
                        .as_deref()
                        == Some("length")
                {
                    return self.array_length(node, obj);
                }
                if matches!(obj.ty(), Type::Object { .. }) {
                    return self.class_index_get(node, obj);
                }
                if matches!(obj.ty(), Type::Classval { .. })
                    && self.class_symbol_key(node.argument_expression()).is_some()
                {
                    let obj = self.coerce(obj, Type::Dyn, node.expression())?;
                    let key = self.expression(node.argument_expression())?;
                    return Ok(self.dynamic_get(node, obj, key));
                }
                if matches!(obj.ty(), Type::Bytes { .. }) {
                    return self.bytes_index(node, obj);
                }
                if let Some(value) = self.nullable_bytes_index(node, obj.clone())? {
                    return Ok(value);
                }
                if matches!(obj.ty(), Type::Union { .. }) {
                    let obj = self.coerce(obj, Type::Dyn, node.expression())?;
                    let key = self.dynamic_read_key_expression(node.argument_expression())?;
                    let value = self.dynamic_get(node, obj, key);
                    let result = self.ty(node)?;
                    return self.coerce(value, result, node);
                }
                if obj.ty() == Type::Dyn || matches!(obj.ty(), Type::Func { .. }) {
                    if matches!(obj.ty(), Type::Func { .. }) {
                        self.function_member_key(node)?;
                    }
                    let obj = self.coerce(obj, Type::Dyn, node)?;
                    let key = self.dynamic_read_key_expression(node.argument_expression())?;
                    return Ok(self.dynamic_get(node, obj, key));
                }
                if let Type::Array { elem } = obj.ty() {
                    // Comparisons must observe a missing slot as undefined,
                    // including through aliases of process.argv. Keep the
                    // owning array and defer extraction to dynamic lookup.
                    let parent = node.parent();
                    let equality = parent.kind() == SyntaxKind::BinaryExpression
                        && matches!(
                            parent.operator_token().kind(),
                            SyntaxKind::EqualsEqualsEqualsToken
                                | SyntaxKind::ExclamationEqualsEqualsToken
                                | SyntaxKind::EqualsEqualsToken
                                | SyntaxKind::ExclamationEqualsToken
                        );
                    let nullish_left = parent.kind() == SyntaxKind::BinaryExpression
                        && parent.operator_token().kind() == SyntaxKind::QuestionQuestionToken
                        && parent.left() == node;
                    let primitive = matches!(
                        *elem,
                        Type::String | Type::F64 | Type::Bool | Type::Bigint | Type::Symbol
                    );
                    let access_type = if node.parent().kind() == SyntaxKind::VariableDeclaration {
                        let symbol = self.symbol(node.parent().name());
                        self.bindings
                            .get(&symbol)
                            .or_else(|| self.module_bindings.get(&symbol))
                            .or_else(|| {
                                self.outer.iter().rev().find_map(|scope| scope.get(&symbol))
                            })
                            .map(|local| local.r#type.clone())
                            .or_else(|| self.var_types.get(&symbol).cloned())
                            .or_else(|| self.module_vars.get(&symbol).cloned())
                            .unwrap_or(self.ty(node)?)
                    } else {
                        self.ty(node)?
                    };
                    let optional_result = self.optional_storage(&access_type);
                    let key = node.argument_expression();
                    let ordinary_index = key.kind() == SyntaxKind::NumericLiteral && {
                        let value = source_frontend::jsnum::from_string(key.text()).value();
                        value.is_finite()
                            && value >= 0.0
                            && value < f64::from(u32::MAX)
                            && value.fract() == 0.0
                    };
                    if *elem == Type::Dyn
                        || self.optional_storage(&elem)
                        || self.process_member(node.expression(), "argv")
                        || (primitive && equality && ordinary_index)
                        || optional_result
                        || nullish_left
                    {
                        let key = self.property_key_expression(node.argument_expression())?;
                        let obj = self.coerce(obj, Type::Dyn, node.expression())?;
                        let value = self.dynamic_get(node, obj, key);
                        let result = if optional_result {
                            access_type
                        } else if *elem == Type::Dyn || self.optional_storage(&elem) {
                            *elem
                        } else {
                            self.undefined_storage_type(*elem, node)?
                        };
                        return self.coerce(value, result, node);
                    }
                    let index = self.expected_expression(node.argument_expression(), Type::F64)?;
                    return Ok(Expr::ArrayGet {
                        arr: Box::new(obj),
                        index: Box::new(index),
                        r#type: *elem,
                        loc: self.loc(node),
                    });
                }
                if let Type::Union { union_id } = obj.ty() {
                    let arms = self.unions[union_id].arms.clone();
                    let arrays = arms
                        .iter()
                        .filter_map(|arm| {
                            if let Type::Array { elem } = arm {
                                Some((**elem).clone())
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>();
                    if !arrays.is_empty()
                        && arms.iter().all(|arm| {
                            matches!(arm, Type::Array { .. } | Type::Null | Type::Undefined)
                        })
                    {
                        // A nullable dictionary payload still needs the source
                        // property read: an absent receiver throws, while a
                        // present array may return undefined for a missing key.
                        let index = self.expression(node.argument_expression())?;
                        if index.ty() != Type::F64 {
                            return Err(self.refuse(
                                node,
                                "nullable array indexing requires a represented numeric key",
                            ));
                        }
                        let key = Expr::ToString {
                            operand: Box::new(index),
                            r#type: Type::String,
                            loc: self.loc(node.argument_expression()),
                        };
                        let object = self.coerce(obj, Type::Dyn, node.expression())?;
                        let value = self.dynamic_get(node, object, key);
                        let element = if arrays.contains(&Type::Dyn) {
                            Type::Dyn
                        } else {
                            self.intern_union(arrays).ok_or_else(|| {
                                self.refuse(node, "array union element layout is recursive")
                            })?
                        };
                        let result = if element == Type::Dyn {
                            Type::Dyn
                        } else {
                            self.undefined_storage_type(element, node)?
                        };
                        return self.coerce(value, result, node);
                    }
                }
                if let Type::Record { shape_id } = obj.ty()
                    && self.records[shape_id].tuple
                {
                    return self.tuple_get(node, obj);
                }
                let key = self.property_key_expression(node.argument_expression())?;
                self.dictionary_get(node, obj, key)
            }
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression => self.closure(node, None),
            SyntaxKind::ObjectLiteralExpression => {
                let ty = self.ty(node)?;
                self.record_literal(node, ty)
            }
            SyntaxKind::ConditionalExpression => {
                // JavaScript conditionals do not declare an ABI. The checker
                // can synthesize a structural common type that widens mutable
                // record fields (for example String -> Dyn), which cannot be
                // represented as an identity-preserving native record view.
                // Build the result from the actual branch ABIs instead.
                if parameter_abi::is_javascript(node) {
                    return self.inferred_conditional_expression(node);
                }
                let ty = self.ty(node)?;
                let ty = if matches!(ty, Type::F64 | Type::String | Type::Bool)
                    && self.argument_may_be_absent(node, &mut HashSet::new())
                {
                    // A branch can produce undefined despite the checked type.
                    // Leave conversion to the consuming JavaScript operation.
                    self.undefined_storage_type(ty, node)?
                } else {
                    ty
                };
                self.expected_expression(node, ty)
            }
            SyntaxKind::NullKeyword => Ok(Expr::UnitLit {
                unit: "null",
                r#type: Type::Null,
                loc,
            }),
            SyntaxKind::ArrayLiteralExpression => {
                let ty = self.ty(node)?;
                self.expected_expression(node, ty)
            }
            SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression => {
                let source = primitives::primitive_source(node);
                if source != node
                    && let Some(snapshot) = self.namespace_index_snapshot(source)?
                {
                    return Ok(snapshot);
                }
                let asserted = self.checker.get_type_at_location(node);
                if self.checker.ty(asserted).flags.intersects(TypeFlags::NEVER) {
                    // `value as never` is an erased TypeScript escape hatch,
                    // commonly used to query readonly literal tuples with a
                    // value that has already been checked at runtime. Never
                    // has no value ABI of its own; preserve the operand.
                    return self.expression(node.expression());
                }
                let target = self.ty(node)?;
                if matches!(
                    node.expression().kind(),
                    SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression
                ) && self.ty(node.expression())? == Type::Dyn
                {
                    let erased = self.expression(node.expression())?;
                    return self.coerce(erased, target, node);
                }
                self.expected_expression(node.expression(), target)
            }
            SyntaxKind::ParenthesizedExpression
            | SyntaxKind::SatisfiesExpression
            | SyntaxKind::NonNullExpression => self.expression(node.expression()),
            SyntaxKind::PropertyAccessExpression if self.module_namespace(node.expression()) => {
                self.expression(node.name())
            }
            SyntaxKind::PropertyAccessExpression => {
                if let Some(value) = self.fs_flag_constant(node, false)? {
                    return Ok(value);
                }
                if let Some(value) = self.immediate_set_first(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.immediate_map_first(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.module_metadata(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.console_value(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.enum_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.codec_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.string_decoder_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.symbol_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.regex_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.statfs_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.stats_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.dirent_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.bun_file_property(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.path_namespace_property(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.error_capture_stack_trace_value(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.class_prototype_data_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.class_get(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.array_method_value(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.primitive_get(node)? {
                    return Ok(value);
                }
                self.record_get(node)
            }
            SyntaxKind::BigIntLiteral => Ok(self.bigint_literal(node)),
            SyntaxKind::NumericLiteral => {
                let text = node.text().replace('_', "");
                let value = source_frontend::jsnum::from_string(&text).value();
                let spelling = (text.bytes().all(|b| b.is_ascii_digit())
                    && value.is_finite()
                    && format!("{value:.0}") != text)
                    .then(|| node.text().to_string());
                Ok(Expr::NumLit {
                    value,
                    spelling,
                    r#type: Type::F64,
                    loc,
                })
            }
            SyntaxKind::TemplateExpression => self.template_expression(node),
            SyntaxKind::TaggedTemplateExpression => {
                if let Some(value) = self.string_raw_template(node)? {
                    Ok(value)
                } else {
                    self.tagged_template_expression(node)
                }
            }
            SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral => {
                let bytes = source_frontend::scanner_util::go_string_bytes(node.text());
                let value = std::str::from_utf8(&bytes)
                    .map_err(|_| self.refuse(node, "lone UTF-16 surrogates are not ported"))?
                    .to_string();
                Ok(Expr::StrLit {
                    value,
                    r#type: Type::String,
                    loc,
                })
            }
            SyntaxKind::TrueKeyword | SyntaxKind::FalseKeyword => Ok(Expr::BoolLit {
                value: node.kind() == SyntaxKind::TrueKeyword,
                r#type: Type::Bool,
                loc,
            }),
            SyntaxKind::Identifier => {
                let trace_identifier =
                    std::env::var_os("SCRIPTC_TRACE_IDENTIFIER_STAGES").is_some();
                let symbol = self.symbol(node);
                if trace_identifier {
                    eprintln!(
                        "scriptc: identifier stage symbol {}:{}..{} {}",
                        self.file,
                        node.pos(),
                        node.end(),
                        node.text()
                    );
                }
                let ambient_global = !self.bindings.contains_key(&symbol)
                    && !self.module_bindings.contains_key(&symbol)
                    && !self.outer.iter().any(|scope| scope.contains_key(&symbol));
                if ambient_global && let Some(value) = self.global_console_value(node)? {
                    return Ok(value);
                }
                if matches!(node.text(), "globalThis" | "global") && ambient_global {
                    return Ok(Expr::Intrinsic {
                        name: "global.object".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if matches!(node.text(), "self" | "window")
                    && ambient_global
                    && self.unavailable_ambient_typeof(node)
                {
                    // Node has no `self`/`window` global: `typeof self` is
                    // "undefined" and reading the name throws ReferenceError.
                    self.ensure_exception_classes(node)?;
                    let name = node.text().to_string();
                    let mut helper = helpers::Helper::new(
                        &format!("unavailable_global_{name}"),
                        vec![],
                        Type::Dyn,
                        loc.clone(),
                    );
                    helper.function.body.push(Stmt::Throw {
                        value: Expr::LibCall {
                            r#fn: "error.new".into(),
                            args: vec![Expr::StrLit {
                                value: format!("{name} is not defined"),
                                r#type: Type::String,
                                loc: loc.clone(),
                            }],
                            r#type: Type::Object {
                                class_name: "%ReferenceError".into(),
                            },
                            loc: loc.clone(),
                        },
                        loc: loc.clone(),
                    });
                    return Ok(Expr::Call {
                        callee: self.install_helper(helper.function),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if node.text() == "navigator" && ambient_global {
                    return Ok(Expr::Intrinsic {
                        name: "global.navigator".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if node.text() == "process" && ambient_global {
                    return Ok(Expr::Intrinsic {
                        name: "global.process".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if node.text() == "fetch" && ambient_global {
                    return Ok(Expr::Intrinsic {
                        name: "global.fetch".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if node.text() == "AbortSignal" && ambient_global {
                    return Ok(Expr::Intrinsic {
                        name: "global.abortSignal".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if ambient_global
                    && let Some(name) = match node.text() {
                        "ReadableStream" => Some("global.readableStreamConstructor"),
                        "Blob" => Some("global.blobConstructor"),
                        "URLSearchParams" => Some("global.urlSearchParamsConstructor"),
                        "File" => Some("global.fileConstructor"),
                        "URL" => Some("global.urlConstructor"),
                        "MessagePort" => Some("global.messagePortConstructor"),
                        "Response" => Some("global.responseConstructor"),
                        "Headers" => Some("global.headersConstructor"),
                        "FormData" => Some("global.formDataConstructor"),
                        _ => None,
                    }
                {
                    return Ok(Expr::Intrinsic {
                        name: name.into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                let native = self.native_symbol(node);
                if self
                    .native_functions
                    .get(&native)
                    .is_some_and(|(module, member)| *module == "url" && member == "URL")
                {
                    return Ok(Expr::Intrinsic {
                        name: "global.urlConstructor".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if node.text() == "Intl" && ambient_global {
                    return Ok(Expr::Intrinsic {
                        name: "global.intl".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if ambient_global && let Some(value) = self.commonjs_path_global(node) {
                    return Ok(Expr::StrLit {
                        value,
                        r#type: Type::String,
                        loc,
                    });
                }
                if let Some(module) = self.native_namespace(node) {
                    return self.native_module_namespace_value(node, module);
                }
                if ambient_global && self.unavailable_ambient_typeof(node) {
                    // `typeof` observes an unavailable host global as
                    // "undefined", while an ordinary read still throws the
                    // catchable ReferenceError required by JavaScript. This
                    // lets feature-gated dependency code remain in the graph
                    // without pretending the host API exists.
                    return Ok(Expr::Intrinsic {
                        name: "global.unbound".into(),
                        args: vec![Expr::StrLit {
                            value: node.text().to_string(),
                            r#type: Type::String,
                            loc: loc.clone(),
                        }],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if ambient_global && node.text().starts_with("__") && node.text().ends_with("__") {
                    // Bundlers commonly replace stamp identifiers before this
                    // stage. In an unbundled checkout they are ordinary
                    // unresolvable references, and JavaScript throws a
                    // catchable ReferenceError when the callback reads them.
                    return Ok(Expr::Intrinsic {
                        name: "global.unbound".into(),
                        args: vec![Expr::StrLit {
                            value: node.text().to_string(),
                            r#type: Type::String,
                            loc: loc.clone(),
                        }],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if let Some(value) = self.global_numeric_value(node, symbol) {
                    return Ok(value);
                }
                if node.text() == "RegExp" && self.regex_symbol(symbol) {
                    return Ok(Expr::LibCall {
                        r#fn: "regex.globalValue".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if node.text() == "Map" && self.primitive_symbol(symbol, "Map", None) {
                    return Ok(Expr::LibCall {
                        r#fn: "map.constructorValue".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if node.text() == "Promise"
                    && symbol != 0
                    && self
                        .checker
                        .sym(source_frontend::prelude::SymbolId(symbol))
                        .name
                        .as_ref()
                        == "Promise"
                    && self.standard_promise(source_frontend::prelude::SymbolId(symbol))
                {
                    return Ok(Expr::LibCall {
                        r#fn: "promise.constructorValue".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if trace_identifier {
                    eprintln!(
                        "scriptc: identifier stage class-value {}:{}..{}",
                        self.file,
                        node.pos(),
                        node.end()
                    );
                }
                if let Some(value) = self.class_value(node)? {
                    return Ok(value);
                }
                if trace_identifier {
                    eprintln!(
                        "scriptc: identifier stage function-value {}:{}..{}",
                        self.file,
                        node.pos(),
                        node.end()
                    );
                }
                if let Some(signature) =
                    self.request_function(symbol, node, functions::UseKind::Value)?
                {
                    return Ok(Expr::Closure {
                        fn_name: signature.name.clone(),
                        captures: vec![],
                        r#type: Type::Func {
                            rest: signature.rest,
                            params: signature.params.iter().map(|p| p.r#type.clone()).collect(),
                            ret: Box::new(signature.return_type.clone()),
                        },
                        loc,
                    });
                }
                if node.text() == "undefined"
                    && symbol != 0
                    && !self.bindings.contains_key(&symbol)
                    && self
                        .checker
                        .sym(source_frontend::prelude::SymbolId(symbol))
                        .value_declaration
                        .is_nil()
                {
                    return Ok(Expr::UnitLit {
                        unit: "undefined",
                        r#type: Type::Undefined,
                        loc,
                    });
                }
                if trace_identifier {
                    eprintln!(
                        "scriptc: identifier stage binding {}:{}..{}",
                        self.file,
                        node.pos(),
                        node.end()
                    );
                }
                let local = self.binding(node)?;
                let value = Expr::VarRef {
                    local_id: local.id,
                    r#type: local.r#type,
                    loc,
                };
                if value.ty() == Type::Dyn && self.native_dynamic_values.contains(&symbol) {
                    return Ok(value);
                }
                if value.ty() == Type::Dyn && self.bind_intrinsic_value(node, &mut HashSet::new()) {
                    return Ok(value);
                }
                if value.ty() == Type::Dyn
                    && let Some(signature) = self.recursive_functions.get(&symbol).cloned()
                    && signature != Type::Dyn
                {
                    return Ok(Expr::DynCheck {
                        value: Box::new(value),
                        r#type: signature,
                        loc: self.loc(node),
                    });
                }
                if self.var_types.contains_key(&symbol) {
                    if trace_identifier {
                        eprintln!(
                            "scriptc: identifier stage variable-narrowing {}:{}..{}",
                            self.file,
                            node.pos(),
                            node.end()
                        );
                    }
                    if !self.var_defined.contains(&symbol) {
                        if let Some(present) = self.nonoptional_property_guarded_value(node, &value)
                        {
                            return Ok(present);
                        }
                        if let Some(array) = self.array_guarded_value(node, &value) {
                            return Ok(array);
                        }
                        if let Some(record) = self.validated_record_value(node, &value) {
                            return Ok(record);
                        }
                        if matches!(value.ty(), Type::Union { .. })
                            && self
                                .ty(node)
                                .is_ok_and(|ty| matches!(ty, Type::Record { .. }))
                        {
                            return self.narrowed(value, node);
                        }
                        return Ok(value);
                    }
                    // JavaScript implementation inference can be `any` even
                    // when its public ABI owns an optional typed slot. A live
                    // presence fact proves the single non-undefined arm, but
                    // not a particular arm of a wider or nullable union.
                    if let Type::Union { union_id } = value.ty()
                        && self.checker_any(node)
                    {
                        let arms = &self.unions[union_id].arms;
                        if arms.len() == 2
                            && arms.contains(&Type::Undefined)
                            && let Some((tag, target)) = arms.iter().enumerate().find(|(_, arm)| {
                                !matches!(arm, Type::Undefined | Type::Null | Type::Void)
                            })
                        {
                            return Ok(Expr::UnionNarrow {
                                union_id: format!("u{union_id}"),
                                tag,
                                value: Box::new(value),
                                r#type: target.clone(),
                                loc: self.loc(node),
                            });
                        }
                    }
                }
                if trace_identifier {
                    eprintln!(
                        "scriptc: identifier stage general-narrowing {}:{}..{}",
                        self.file,
                        node.pos(),
                        node.end()
                    );
                }
                self.narrowed(value, node)
            }
            SyntaxKind::PostfixUnaryExpression => self.update_expression(node),
            SyntaxKind::PrefixUnaryExpression
                if matches!(
                    node.operator(),
                    SyntaxKind::PlusPlusToken | SyntaxKind::MinusMinusToken
                ) =>
            {
                self.update_expression(node)
            }
            SyntaxKind::PrefixUnaryExpression => {
                let op = match node.operator() {
                    SyntaxKind::PlusToken => "+",
                    SyntaxKind::MinusToken => "-",
                    SyntaxKind::ExclamationToken => "!",
                    SyntaxKind::TildeToken => "~",
                    _ => return Err(self.refuse(node, "unary operator is not ported")),
                };
                if op == "!" {
                    let raw = self.condition_value(node.operand())?;
                    let operand = self.condition(raw, node.operand())?;
                    return Ok(Expr::Unary {
                        op: "!".into(),
                        operand: Box::new(operand),
                        r#type: Type::Bool,
                        loc,
                    });
                }
                let raw = self.expression(node.operand())?;
                if op == "+" {
                    return self.primitive_number(raw, node);
                }
                if op == "~" {
                    return self.numeric_not(raw, node);
                }
                if op == "-" && raw.ty() == Type::Bigint {
                    return Ok(self.bigint_operation("bigint.neg", vec![raw], node));
                }
                let raw = if op == "-"
                    && raw.ty() != Type::F64
                    && self.ty(node).is_ok_and(|ty| ty == Type::F64)
                {
                    self.primitive_number(raw, node)?
                } else {
                    raw
                };
                let operand = Box::new(raw);
                if !matches!((op, operand.ty()), ("-", Type::F64) | ("!", Type::Bool)) {
                    return Err(self.refuse(node, "unary coercions are not ported"));
                }
                let r#type = if op == "!" { Type::Bool } else { Type::F64 };
                Ok(Expr::Unary {
                    op: op.into(),
                    operand,
                    r#type,
                    loc,
                })
            }
            SyntaxKind::BinaryExpression => {
                if node.operator_token().kind() == SyntaxKind::CommaToken {
                    let left = self.expression(node.left())?;
                    let right = self.expression(node.right())?;
                    let r#type = right.ty();
                    return Ok(Expr::Sequence {
                        stmts: vec![Stmt::Expression {
                            expr: left,
                            loc: self.loc(node.left()),
                        }],
                        result: Box::new(right),
                        r#type,
                        loc,
                    });
                }
                if node.operator_token().kind() == SyntaxKind::QuestionQuestionToken
                    && node.right().kind() == SyntaxKind::NumericLiteral
                    && source_frontend::jsnum::from_string(node.right().text()).value() == 0.0
                    && let Some(value) = self.fs_flag_constant(node.left(), true)?
                {
                    return Ok(value);
                }
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && let Some(value) = self.bytes_assignment(node, None)?
                {
                    return Ok(value);
                }
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && primitives::primitive_source(node.left()).kind()
                        == SyntaxKind::ObjectLiteralExpression
                {
                    return self.object_assignment_expression(node);
                }
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && primitives::primitive_source(node.left()).kind()
                        == SyntaxKind::ArrayLiteralExpression
                {
                    return self.array_assignment_expression(node);
                }
                if node.operator_token().kind() == SyntaxKind::QuestionQuestionEqualsToken {
                    return self.nullish_assignment_expression(node);
                }
                if matches!(
                    node.operator_token().kind(),
                    SyntaxKind::BarBarEqualsToken | SyntaxKind::AmpersandAmpersandEqualsToken
                ) {
                    return self.logical_assignment_expression(node);
                }
                if let Some(op) = updates::compound_operator(node.operator_token().kind()) {
                    return self.compound_assignment(node, op);
                }
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && node.left().kind() == SyntaxKind::PropertyAccessExpression
                    && node.left().name().kind() == SyntaxKind::PrivateIdentifier
                {
                    return self.private_assignment(node);
                }
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && let Some(value) = self.class_prototype_data_assignment(node)?
                {
                    return Ok(value);
                }
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && node.left().kind() == SyntaxKind::PropertyAccessExpression
                    && let Some(value) = self.class_accessor_assignment(node)?
                {
                    return Ok(value);
                }
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && primitives::primitive_source(node.left()).kind()
                        == SyntaxKind::PropertyAccessExpression
                {
                    return self.property_assignment_expression(node);
                }
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && primitives::primitive_source(node.left()).kind() == SyntaxKind::Identifier
                {
                    return self.local_assignment_expression(node);
                }
                if node.operator_token().kind() == SyntaxKind::EqualsToken
                    && primitives::primitive_source(node.left()).kind()
                        == SyntaxKind::ElementAccessExpression
                {
                    return self.dynamic_element_assignment_expression(node);
                }
                if node.operator_token().kind() == SyntaxKind::InstanceOfKeyword {
                    return self.class_instanceof(node);
                }
                if node.operator_token().kind() == SyntaxKind::InKeyword
                    && node.left().kind() == SyntaxKind::PrivateIdentifier
                {
                    return self.private_brand_check(node);
                }
                let op = match node.operator_token().kind() {
                    SyntaxKind::PlusToken => "+",
                    SyntaxKind::MinusToken => "-",
                    SyntaxKind::AsteriskToken => "*",
                    SyntaxKind::SlashToken => "/",
                    SyntaxKind::PercentToken => "%",
                    SyntaxKind::AsteriskAsteriskToken => "**",
                    SyntaxKind::AmpersandToken => "&",
                    SyntaxKind::BarToken => "|",
                    SyntaxKind::CaretToken => "^",
                    SyntaxKind::LessThanLessThanToken => "<<",
                    SyntaxKind::GreaterThanGreaterThanToken => ">>",
                    SyntaxKind::GreaterThanGreaterThanGreaterThanToken => ">>>",
                    SyntaxKind::LessThanToken => "<",
                    SyntaxKind::LessThanEqualsToken => "<=",
                    SyntaxKind::GreaterThanToken => ">",
                    SyntaxKind::GreaterThanEqualsToken => ">=",
                    SyntaxKind::EqualsEqualsEqualsToken => "===",
                    SyntaxKind::ExclamationEqualsEqualsToken => "!==",
                    SyntaxKind::EqualsEqualsToken => "==",
                    SyntaxKind::ExclamationEqualsToken => "!=",
                    SyntaxKind::AmpersandAmpersandToken => "&&",
                    SyntaxKind::BarBarToken => "||",
                    SyntaxKind::QuestionQuestionToken => "??",
                    SyntaxKind::InKeyword => "in",
                    _ => return Err(self.refuse(node, "binary operator is not ported")),
                };
                self.binary(node, op)
            }
            SyntaxKind::VoidExpression => {
                let mut value = self.expression(node.expression())?;
                if matches!(value.ty(), Type::Null | Type::Undefined) {
                    value = self.coerce(value, Type::Dyn, node.expression())?;
                }
                Ok(Expr::Sequence {
                    stmts: vec![Stmt::Expression {
                        expr: value,
                        loc: loc.clone(),
                    }],
                    result: Box::new(Expr::DynFrom {
                        value: Box::new(Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: loc.clone(),
                        }),
                        r#type: Type::Dyn,
                        loc: loc.clone(),
                    }),
                    r#type: Type::Dyn,
                    loc,
                })
            }
            SyntaxKind::TypeOfExpression => {
                if self.commonjs_path_global(node.expression()).is_some() {
                    return Ok(Expr::StrLit {
                        value: "string".into(),
                        r#type: Type::String,
                        loc,
                    });
                }
                if self.standard_performance_value(node.expression()) {
                    return Ok(Expr::StrLit {
                        value: "object".into(),
                        r#type: Type::String,
                        loc,
                    });
                }
                if self.unavailable_ambient_typeof(node.expression()) {
                    return Ok(Expr::StrLit {
                        value: "undefined".into(),
                        r#type: Type::String,
                        loc,
                    });
                }
                if self
                    .native_namespace(node.expression())
                    .is_some_and(|module| matches!(module, "Bun" | "process"))
                {
                    // Ambient host namespaces do not own a runtime cell in
                    // the generated program. Their Rust adapters are present
                    // by construction, so a host-availability guard observes
                    // the same object-like namespace without trying to capture
                    // an unlowered declaration-file symbol.
                    return Ok(Expr::StrLit {
                        value: "object".into(),
                        r#type: Type::String,
                        loc,
                    });
                }
                if self.standard_buffer_value(node.expression())
                    || self.standard_bigint_value(node.expression())
                    || self.standard_constructor_typeof(node.expression())
                    || self.native_callable_value(node.expression())
                {
                    return Ok(Expr::StrLit {
                        value: "function".into(),
                        r#type: Type::String,
                        loc,
                    });
                }
                let value = self.condition_value(node.expression())?;
                if async_context::instance(&value.ty())
                    || weak_maps::instance(&value.ty())
                    || classes::weak_sets::instance(&value.ty())
                {
                    return Ok(Expr::Sequence {
                        stmts: vec![Stmt::Expression {
                            expr: value,
                            loc: loc.clone(),
                        }],
                        result: Box::new(Expr::StrLit {
                            value: "object".into(),
                            r#type: Type::String,
                            loc: loc.clone(),
                        }),
                        r#type: Type::String,
                        loc,
                    });
                }
                let value = self.coerce(value, Type::Dyn, node)?;
                Ok(Expr::LibCall {
                    r#fn: "dyn.typeof".into(),
                    args: vec![value],
                    r#type: Type::String,
                    loc,
                })
            }
            SyntaxKind::CallExpression
                if node.arguments().is_empty() && {
                    // UMD global detection: `Function('return this')()`.
                    // A sloppy function called without a receiver returns the
                    // global object; no source text is evaluated.
                    let factory = primitives::primitive_source(node.expression());
                    factory.kind() == SyntaxKind::CallExpression
                        && factory.expression().kind() == SyntaxKind::Identifier
                        && factory.expression().text() == "Function"
                        && {
                            let args = factory.arguments().into_iter().collect::<Vec<_>>();
                            matches!(args.as_slice(), [body]
                                if body.kind() == SyntaxKind::StringLiteral
                                    && body.text().trim() == "return this")
                        }
                        && {
                            let symbol = self.symbol(factory.expression());
                            !self.bindings.contains_key(&symbol)
                                && !self.module_bindings.contains_key(&symbol)
                                && !self.outer.iter().any(|scope| scope.contains_key(&symbol))
                        }
                } =>
            {
                Ok(Expr::Intrinsic {
                    name: "global.object".into(),
                    args: vec![],
                    r#type: Type::Dyn,
                    loc,
                })
            }
            SyntaxKind::CallExpression => {
                self.validate_tls_peer_certificate_call(node)?;
                self.demand_event_emitter_extension_method(node)?;
                if let Some(value) = self.bun_ffi_call(node)? {
                    return Ok(value);
                }
                if self.null_object_factory_call(node) {
                    return Ok(Expr::Intrinsic {
                        name: "object.nullConstructor".into(),
                        args: vec![],
                        r#type: Type::Dyn,
                        loc,
                    });
                }
                if let Some(value) = self.spawn_sync_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.timer_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.child_event_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.child_stdin_call(node, false)? {
                    return Ok(value);
                }
                if let Some(value) = self.bun_shell_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.bun_child_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.bun_file_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.crypto_hash_chain(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.crypto_sign_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.crypto_sign_handle_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.crypto_hash_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.crypto_hash_handle_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.crypto_private_key_export_chain(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.crypto_web_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.sqlite_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.inspector_session_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.dynamic_import_call(node, None)? {
                    return Ok(value);
                }
                if let Some(value) = self.immediate_map_next(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.stored_map_next(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.generator_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.bun_response_text(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.function_source_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.boxed_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.process_stdin_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.process_write(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.process_exception_listener(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.buffer_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.stats_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.dirent_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_get_prototype_of_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_is_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_is_frozen_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.standard_object_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_freeze_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.event_emitter_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.dom_event_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.dom_target_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.standard_function_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.number_predicate_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.number_parser_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.bigint_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.regex_new(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.codec_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.primitive_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_prototype_has_own_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.function_receiver_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.json_function_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.promisify_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.weak_map_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.async_resource_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.weak_set_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.async_context_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_get_own_property_descriptor(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_get_own_property_names(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_get_own_property_symbols(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_define_properties(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_define_data(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.reflect_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.object_reflection(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.console_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.string_decoder_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.symbol_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.array_buffer_is_view(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.node_assert_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.promise_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.error_capture_stack_trace_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.function_bind(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.callable_assign(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.regex_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.path_namespace_call(node)? {
                    return Ok(value);
                }
                let native_member = node.expression();
                if native_member.kind() == SyntaxKind::PropertyAccessExpression
                    && let Some(module) = self.native_namespace(native_member.expression())
                {
                    return self.native_call(node, module, native_member.name().text());
                }
                if let Some(value) = self.namespace_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.class_symbol_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.class_static_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.class_call(node)? {
                    return Ok(value);
                }
                if let Some(value) = self.error_call(node)? {
                    return Ok(value);
                }
                let member = node.expression();
                if self.commonjs_import(member).is_some() {
                    return self.call_value(node);
                }
                if member.kind() == SyntaxKind::PropertyAccessExpression {
                    // A heterogeneous literal receiver may have no closed
                    // checker layout even though concat itself establishes an
                    // owning Array<Dyn> contract. Dispatch from that contract
                    // before probing the receiver as a standalone expression.
                    if member.name().text() == "concat"
                        && self.array_concat_result_type(node).is_some()
                    {
                        return self.array_call(node);
                    }
                    let symbol = self.symbol(member.expression());
                    let mut receiver_type = self
                        .bindings
                        .get(&symbol)
                        .or_else(|| self.module_bindings.get(&symbol))
                        .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                        .map(|l| l.r#type.clone())
                        .or_else(|| self.ty(member.expression()).ok());
                    // Fluent calls such as `text.split(',').map(...)` have a
                    // call-expression receiver whose symbol can point at the
                    // invoked member rather than an owning local. The checker
                    // result is authoritative when it proves a concrete array
                    // view, so do not let that incidental symbol shadow it.
                    let checked_receiver = self.ty(member.expression()).ok();
                    if checked_receiver
                        .as_ref()
                        .is_some_and(|ty| self.array_view(ty))
                    {
                        receiver_type = checked_receiver;
                    }
                    if matches!(receiver_type, Some(Type::Dyn | Type::Union { .. })) {
                        let checked = self.ty(member.expression()).ok();
                        // Flow guards such as Array.isArray can refine an
                        // erased binding to an owning array. Conversely, a JS
                        // implementation can be checked as `any` while its
                        // declaration ABI retains a nullable array. Prefer the
                        // concrete view and never replace one with Dyn.
                        if !matches!(checked, Some(Type::Dyn) | None) {
                            receiver_type = checked;
                        }
                    }
                    if matches!(receiver_type, Some(Type::Dyn))
                        && Self::supported_array_method(&member.name().text())
                    {
                        // In unannotated JavaScript the checker can leave a
                        // fluent intermediate as `any` even though lowering
                        // its receiver proves an owning native array (for
                        // example `stringValue.split(',').map(...)`). Probe on
                        // an isolated graph so no effects or helper demands are
                        // committed, then let the normal array path lower the
                        // real expression exactly once.
                        let represented_array = {
                            let mut probe = self.diagnostic_fork();
                            probe
                                .expression(member.expression())
                                .is_ok_and(|value| probe.array_view(&value.ty()))
                        };
                        if represented_array {
                            return self.array_call(node);
                        }
                    }
                    if receiver_type.as_ref().is_some_and(|ty| self.array_view(ty)) {
                        return self.array_call(node);
                    }
                    if matches!(receiver_type, Some(Type::Record { shape_id }) if self.records[shape_id].tuple)
                    {
                        return match member.name().text() {
                            "join" => self.array_join(node),
                            "includes" => self.tuple_includes(node),
                            _ => Err(self.refuse(node, "tuple method is not ported")),
                        };
                    }
                    if let Some(expected @ Type::Map { .. }) = receiver_type.clone() {
                        let mut receiver = self.expression(member.expression())?;
                        if receiver.ty() != expected {
                            receiver = self.coerce(receiver, expected, member.expression())?;
                        }
                        return self.map_intrinsic(
                            node,
                            receiver,
                            member.name().text(),
                            node.arguments().into_iter().collect(),
                        );
                    }
                    if matches!(receiver_type, Some(Type::Set { .. }))
                        || matches!(self.ty(member.expression()), Ok(Type::Set { .. }))
                    {
                        let expected = receiver_type
                            .clone()
                            .or_else(|| self.ty(member.expression()).ok())
                            .filter(|ty| matches!(ty, Type::Set { .. }));
                        let mut receiver = self.expression(member.expression())?;
                        if let Some(expected) = expected
                            && receiver.ty() != expected
                        {
                            receiver = self.coerce(receiver, expected, member.expression())?;
                        }
                        return self.set_intrinsic(
                            node,
                            receiver,
                            member.name().text(),
                            node.arguments().into_iter().collect(),
                        );
                    }
                }
                if self.ambient_fetch_call(node) {
                    // `fetch(...)` and `globalThis.fetch(...)` resolve to the
                    // same identity-bearing host callable. Lower both through
                    // the represented global value so Promise/Response
                    // identity remains intact without a source call target.
                    return self.call_value(node);
                }
                if member.kind() == SyntaxKind::Identifier {
                    let native = self.native_symbol(member);
                    if let Some((module, name)) = self.native_functions.get(&native).cloned() {
                        return self.native_call(node, module, &name);
                    }
                    let symbol = self.symbol(member);
                    if self.bindings.contains_key(&symbol)
                        || self.module_bindings.contains_key(&symbol)
                        || self.outer.iter().any(|scope| scope.contains_key(&symbol))
                    {
                        return self.call_value(node);
                    }
                } else if matches!(
                    member.kind(),
                    SyntaxKind::ParenthesizedExpression
                        | SyntaxKind::AsExpression
                        | SyntaxKind::TypeAssertionExpression
                        | SyntaxKind::SatisfiesExpression
                        | SyntaxKind::NonNullExpression
                        | SyntaxKind::ElementAccessExpression
                        | SyntaxKind::CallExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::FunctionExpression
                ) {
                    return self.call_value(node);
                }
                if node
                    .arguments()
                    .into_iter()
                    .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
                {
                    // Specialized native adapters above have already had the
                    // opportunity to claim this call. Imported namespace
                    // functions still need JavaScript's runtime-sized spread
                    // semantics, so invoke their represented callable value
                    // through the shared spread boundary instead of forcing a
                    // fixed declaration ABI in the direct-symbol path below.
                    return self.call_value(node);
                }
                if member.kind() == SyntaxKind::PropertyAccessExpression {
                    let receiver = member.expression();
                    let owned = if receiver.kind() == SyntaxKind::Identifier {
                        let symbol = self.symbol(receiver);
                        self.commonjs_import(receiver).is_some()
                            || self.bindings.contains_key(&symbol)
                            || self.module_bindings.contains_key(&symbol)
                            || self.outer.iter().any(|scope| scope.contains_key(&symbol))
                            || self.functions.source_node(symbol).is_some()
                            || matches!(self.ty(receiver), Ok(Type::Classval { .. }))
                            || (receiver.text() == "AbortSignal"
                                && !self.bindings.contains_key(&symbol)
                                && !self.module_bindings.contains_key(&symbol)
                                && !self.outer.iter().any(|scope| scope.contains_key(&symbol)))
                    } else {
                        !self.module_namespace(receiver)
                    };
                    let checked_receiver = self.ty(receiver);
                    // A structural interface view whose owning storage is an
                    // erased class instance (`this.cache` holding `new
                    // LRUCache()`): invoke the method on that receiver so the
                    // callee observes it as `this`, then check the result view.
                    if matches!(
                        checked_receiver,
                        Ok(Type::Record { .. } | Type::Union { .. })
                    ) && (receiver.kind() == SyntaxKind::Identifier
                        || (receiver.kind() == SyntaxKind::PropertyAccessExpression
                            && receiver.expression().kind() == SyntaxKind::ThisKeyword))
                        && member.name().kind() == SyntaxKind::Identifier
                        && !node
                            .arguments()
                            .into_iter()
                            .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
                    {
                        let restore = self.diagnostic_checkpoint();
                        let recv = self.expression(receiver)?;
                        if recv.ty() == Type::Dyn {
                            let args = node
                                .arguments()
                                .into_iter()
                                .map(|argument| self.expected_expression(argument, Type::Dyn))
                                .collect::<Result<Vec<_>, _>>()?;
                            let value = Expr::DynInvoke {
                                recv: Box::new(recv),
                                method: member.name().text().into(),
                                callee_name: member.name().text().into(),
                                optional: false,
                                args,
                                r#type: Type::Dyn,
                                loc: loc.clone(),
                            };
                            return match self.ty(node) {
                                Ok(Type::Dyn | Type::Void | Type::Undefined | Type::Null)
                                | Err(_) => Ok(value),
                                Ok(view) => self.coerce(value, view, node),
                            };
                        }
                        restore(self);
                    }
                    if owned
                        && matches!(
                            checked_receiver,
                            Ok(Type::Dyn | Type::Map { .. } | Type::Promise { .. })
                        )
                    {
                        let mut recv = self.expression(receiver)?;
                        if matches!(recv.ty(), Type::Map { .. }) {
                            return self.map_intrinsic(
                                node,
                                recv,
                                member.name().text(),
                                node.arguments().into_iter().collect(),
                            );
                        }
                        if matches!(checked_receiver, Ok(Type::Dyn)) && recv.ty() != Type::Dyn {
                            // The checker deliberately erases `this` for dynamic JavaScript
                            // fields (for example a class field initialized to null and
                            // replaced with a callback in the constructor).  The represented
                            // receiver still carries the exact native class ABI, so project it
                            // through NativeValue before looking up and invoking the runtime
                            // property.  This keeps JavaScript's receiver identity and avoids
                            // trusting the stale initializer type of the member itself.
                            recv = self.coerce(recv, Type::Dyn, receiver)?;
                        }
                        if recv.ty() == Type::Dyn {
                            let source_arguments = node.arguments().into_iter().collect::<Vec<_>>();
                            if source_arguments
                                .iter()
                                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
                            {
                                let mut stmts = Vec::new();
                                let recv = self.update_temp(recv, &mut stmts, receiver);
                                let args = self.array_spread_elements(
                                    node,
                                    source_arguments,
                                    Type::Array {
                                        elem: Box::new(Type::Dyn),
                                    },
                                )?;
                                let method = Expr::StrLit {
                                    value: member.name().text().into(),
                                    r#type: Type::String,
                                    loc: self.loc(member.name()),
                                };
                                return Ok(Expr::Sequence {
                                    stmts,
                                    result: Box::new(Expr::LibCall {
                                        r#fn: "dyn.invokeSpread".into(),
                                        args: vec![recv, method, args],
                                        r#type: Type::Dyn,
                                        loc: loc.clone(),
                                    }),
                                    r#type: Type::Dyn,
                                    loc,
                                });
                            }
                            let args = source_arguments
                                .into_iter()
                                .map(|a| self.expected_expression(a, Type::Dyn))
                                .collect::<Result<Vec<_>, _>>()?;
                            let display_receiver = receivers::reference_node(receiver);
                            let callee_name = if matches!(display_receiver.kind(), SyntaxKind::Identifier | SyntaxKind::ThisKeyword) {
                                format!("{}.{}", display_receiver.text(), member.name().text())
                            } else {
                                member.name().text().into()
                            };
                            return Ok(Expr::DynInvoke {
                                recv: Box::new(recv),
                                method: member.name().text().into(),
                                callee_name,
                                optional: false,
                                args,
                                r#type: Type::Dyn,
                                loc,
                            });
                        }
                    }
                    if owned {
                        let checked = self.ty(member);
                        let checked_receiver = self.ty(member.expression()).ok();
                        let callable = match checked {
                            Ok(Type::Func { .. } | Type::Dyn) => true,
                            Ok(Type::Record { shape_id }) => self.callables.contains_key(&shape_id),
                            Ok(Type::Union { union_id })
                                if self.directly_truthy_selected_property(member) =>
                            {
                                self.unions[union_id]
                                    .arms
                                    .iter()
                                    .any(|arm| matches!(arm, Type::Func { .. }))
                                    && self.unions[union_id].arms.iter().all(|arm| {
                                        matches!(
                                            arm,
                                            Type::Func { .. }
                                                | Type::Null
                                                | Type::Undefined
                                                | Type::Void
                                        )
                                    })
                            }
                            _ => match checked_receiver.as_ref() {
                                Some(Type::Record { shape_id }) => self.records[*shape_id]
                                    .fields
                                    .iter()
                                    .find(|field| field.name == member.name().text())
                                    .is_some_and(|field| match &field.r#type {
                                        Type::Func { .. } | Type::Dyn => true,
                                        Type::Record { shape_id } => {
                                            self.callables.contains_key(shape_id)
                                        }
                                        _ => false,
                                    }),
                                _ => false,
                            },
                        };
                        if callable {
                            if let Some(receiver_type @ Type::Union { .. }) = &checked_receiver
                                && self.directly_truthy_selected_property(member)
                            {
                                self.classes.defer_dynamic_method_for_type(
                                    receiver_type,
                                    member.name().text(),
                                    &self.unions,
                                );
                            }
                            return self.call_value(node);
                        }
                    }
                }
                let symbol_node = if member.kind() == SyntaxKind::PropertyAccessExpression {
                    member.name()
                } else {
                    member
                };
                // A namespace identifier has no runtime evaluation. Other
                // receivers can have side effects and cannot be discarded.
                let namespace_call = member.kind() == SyntaxKind::PropertyAccessExpression
                    && self.module_namespace(member.expression());
                if member.kind() == SyntaxKind::Identifier || namespace_call {
                    let canonical = self.call_target(member, &mut HashSet::new());
                    let symbol = if canonical == 0 {
                        self.symbol(symbol_node)
                    } else {
                        canonical
                    };
                    if namespace_call && self.module_bindings.contains_key(&symbol) {
                        return self.call_value(node);
                    }
                    if let Some(mut signature) =
                        self.request_function(symbol, node, functions::UseKind::Call)?
                    {
                        let mut changed = false;
                        if !node
                            .arguments()
                            .into_iter()
                            .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
                        {
                            for (index, argument) in node.arguments().into_iter().enumerate() {
                                if index < signature.params.len()
                                    && self.standard_map_values_call(argument)
                                {
                                    if signature.params[index].r#type != Type::Dyn {
                                        signature.params[index].r#type = Type::Dyn;
                                        changed = true;
                                    }
                                    continue;
                                }
                                let planned = self.planned_argument_type(argument);
                                let expected = signature
                                    .params
                                    .get(index)
                                    .map(|param| param.r#type.clone());
                                if matches!(&planned, Some(Type::Object { .. }))
                                    && matches!(&expected, Some(Type::Record { .. }))
                                {
                                    // A nominal class can implement a public
                                    // structural interface without becoming a
                                    // copied record.  Use NativeValue as the
                                    // function's owning ABI so class and plain
                                    // record callers share identity-preserving
                                    // property access in the implementation.
                                    signature.params[index].r#type = Type::Dyn;
                                    changed = true;
                                    continue;
                                }
                                if argument.kind() == SyntaxKind::ObjectLiteralExpression
                                    && let Some(expected) = signature
                                        .params
                                        .get(index)
                                        .map(|param| param.r#type.clone())
                                    && let Some(actual) =
                                        self.instance_preserving_literal_type(argument, expected)?
                                {
                                    signature.params[index].r#type = actual;
                                    changed = true;
                                    continue;
                                }
                                let expected =
                                    signature.params.get(index).map(|param| &param.r#type);
                                if !(signature.rest && index + 1 == signature.params.len())
                                    && planned.as_ref().zip(expected).is_some_and(
                                        |(actual, expected)| {
                                            !self.contextual_result_compatible(actual, expected)
                                        },
                                    )
                                {
                                    signature.params[index].r#type = Type::Dyn;
                                    changed = true;
                                    continue;
                                }
                                let actual = planned.and_then(|ty| match expected {
                                    Some(
                                        expected @ (Type::Generator { r#async: false, .. }
                                        | Type::Union { .. }),
                                    ) => self.synchronous_iterable_argument(ty, expected),
                                    Some(Type::Record { .. }) => {
                                        self.synchronous_generator_argument(ty)
                                    }
                                    _ => None,
                                });
                                if let Some(actual) = actual {
                                    signature.params[index].r#type = actual;
                                    changed = true;
                                }
                            }
                        }
                        if changed && !self.functions.replace_queued(symbol, signature.clone()) {
                            let existing = self.functions.signature(symbol).unwrap().clone();
                            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
                            let guarded = signature
                                .params
                                .iter()
                                .zip(&existing.params)
                                .enumerate()
                                .all(|(index, (requested, fixed))| {
                                    requested.r#type == fixed.r#type
                                        || arguments.get(index).is_some_and(|argument| {
                                            self.guarded_truthy_call_argument(
                                                *argument,
                                                &fixed.r#type,
                                            )
                                        })
                                });
                            if !guarded {
                                if std::env::var_os("SCRIPTC_TRACE_ABI").is_some() {
                                    let types = existing
                                        .params
                                        .iter()
                                        .map(|param| param.r#type.clone())
                                        .collect::<Vec<_>>();
                                    let mut probe = self.diagnostic_fork();
                                    match probe.rest_call_arguments(node, &types, existing.rest) {
                                        Ok(arguments) => {
                                            eprintln!(
                                                "scriptc: fixed ABI argument probe succeeded: {arguments:#?}"
                                            );
                                            for argument in &arguments {
                                                if let Expr::DynCheck { value, r#type, .. } =
                                                    argument
                                                    && let Expr::DynFrom {
                                                        value: original, ..
                                                    } = value.as_ref()
                                                {
                                                    eprintln!(
                                                        "scriptc: ABI view source={} target={} invariant={:?} checked={:?}",
                                                        probe.contextual_type_description(
                                                            &original.ty()
                                                        ),
                                                        probe.contextual_type_description(r#type),
                                                        ir::record_views::view_pairs(
                                                            &original.ty(),
                                                            r#type,
                                                            &probe.records,
                                                            &probe.unions
                                                        ),
                                                        ir::record_views::dynamic_view_pairs(
                                                            &original.ty(),
                                                            r#type,
                                                            &probe.records,
                                                            &probe.unions
                                                        )
                                                    );
                                                }
                                            }
                                        }
                                        Err(error) => eprintln!(
                                            "scriptc: fixed ABI argument probe refused: {error}"
                                        ),
                                    }
                                }
                                let fixed = existing
                                    .params
                                    .iter()
                                    .map(|param| param.r#type.clone())
                                    .collect::<Vec<_>>();
                                let requested = signature
                                    .params
                                    .iter()
                                    .map(|param| param.r#type.clone())
                                    .collect::<Vec<_>>();
                                let source_name = if existing.node.name().is_nil() {
                                    "<anonymous>"
                                } else {
                                    existing.node.name().text()
                                };
                                return Err(self.refuse(
                                    node,
                                    &format!("function ABI was already fixed by an incompatible demand: function {} ({source_name}), source {}, fixed {:?}, requested {:?}", existing.name, existing.file, fixed, requested),
                                ));
                            }
                            // The short-circuit test and first argument read the
                            // same binding without an intervening operation. Let
                            // the call's checked projection use the existing ABI.
                            signature = existing;
                        }
                        if namespace_call && receivers::reads_this(signature.node) {
                            return Err(self.refuse(
                                node,
                                "namespace method this requires a native namespace receiver",
                            ));
                        }
                        let types = signature
                            .params
                            .iter()
                            .map(|p| p.r#type.clone())
                            .collect::<Vec<_>>();
                        if std::env::var_os("SCRIPTC_TRACE_DIRECT_CALLS").is_some()
                            && self
                                .file
                                .replace('\\', "/")
                                .ends_with("/zod/v4/classic/schemas.js")
                            && (18_500..18_900).contains(&node.pos())
                        {
                            eprintln!(
                                "scriptc: direct call {}:{}..{} target={} symbol={} params={types:?} result={:?}",
                                self.file,
                                node.pos(),
                                node.end(),
                                symbol_node.text(),
                                symbol,
                                signature.return_type,
                            );
                        }
                        let args = self.rest_call_arguments(node, &types, signature.rest)?;
                        return Ok(Expr::Call {
                            callee: signature.name,
                            args,
                            r#type: signature.return_type,
                            loc,
                        });
                    }
                }
                if std::env::var_os("SCRIPTC_TRACE_CALL_TARGETS").is_some() {
                    let checked = self.ty(member);
                    let receiver = if member.kind() == SyntaxKind::PropertyAccessExpression {
                        Some(self.ty(member.expression()))
                    } else {
                        None
                    };
                    let receiver_arms = receiver.as_ref().and_then(|result| match result {
                        Ok(Type::Union { union_id }) => Some(self.unions[*union_id].arms.clone()),
                        _ => None,
                    });
                    let file = self.file.clone();
                    eprintln!(
                        "scriptc: unresolved call target {:?} at {}:{}..{} checked={:?} receiver={:?} arms={:?}",
                        member.kind(),
                        file,
                        node.pos(),
                        node.end(),
                        checked,
                        receiver,
                        receiver_arms,
                    );
                }
                Err(self.refuse(node, "call target has no native representation"))
            }
            _ => Err(self.refuse(node, "expression is not ported")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_windows_paths_reach_the_frontend_as_canonical_paths() {
        assert_eq!(
            path_for_frontend(Path::new(r"\\?\C:\code\entry.ts")),
            "C:/code/entry.ts"
        );
        assert_eq!(
            path_for_frontend(Path::new(r"\\?\UNC\server\share\entry.ts")),
            "//server/share/entry.ts"
        );
    }
}
