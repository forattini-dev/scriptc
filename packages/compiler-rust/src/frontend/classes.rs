//! Error identities, definition-time effects and demand-driven constructor bodies.
use super::*;
use source_frontend::prelude::{SignatureKind, SymbolId, get_source_file_of_node};
use std::collections::VecDeque;

#[derive(Clone)]
struct Definition {
    node: Node,
    name: String,
    file: String,
    base: Option<usize>,
    resolved: bool,
    resolving: bool,
    signature: Option<Vec<Param>>,
    token: Option<Local>,
}

#[derive(Default)]
pub(super) struct ClassGraph {
    definitions: Vec<Definition>,
    symbols: HashMap<u32, usize>,
    pub layouts: Vec<Option<ir::Class>>,
    pending: VecDeque<usize>,
    layout_active: HashSet<usize>,
}

impl ClassGraph {
    pub fn next(&mut self) -> Option<usize> {
        self.pending.pop_front()
    }
    pub fn subclass(&self, child: &str, parent: &str) -> bool {
        let mut index = self.definitions.iter().position(|d| d.name == child);
        for _ in 0..=self.definitions.len() {
            let Some(i) = index else { return false };
            if self.definitions[i].name == parent {
                return true;
            }
            index = self.definitions[i].base;
        }
        false
    }
    fn object(&self, index: usize) -> Type {
        Type::Object {
            class_name: self.definitions[index].name.clone(),
        }
    }
}

impl Lowerer<'_> {
    pub(super) fn inventory_classes(&mut self, files: &[Node]) {
        for file in files {
            for node in file.statements() {
                if node.kind() != SyntaxKind::ClassDeclaration || node.name().is_nil() {
                    continue;
                }
                let symbol = self.symbol(node.name());
                let index = self.classes.definitions.len();
                let token = Local {
                    id: format!("%g.class.{index}"),
                    name: node.name().text().into(),
                    r#type: Type::F64,
                    mutable: false,
                    boxed: false,
                };
                self.globals.push(ir::Global {
                    id: token.id.clone(),
                    name: token.name.clone(),
                    r#type: Type::F64,
                    mutable: false,
                });
                self.classes.symbols.insert(symbol, index);
                self.classes.definitions.push(Definition {
                    node,
                    name: format!("native_error_{index}"),
                    file: source_file_info(*file).file_name.to_string(),
                    base: None,
                    resolved: false,
                    resolving: false,
                    signature: None,
                    token: Some(token),
                });
                self.classes.layouts.push(None);
            }
        }
    }

    fn builtin_class(&mut self, symbol: u32) -> Option<usize> {
        if let Some(index) = self.classes.symbols.get(&symbol) {
            return Some(*index);
        }
        if symbol == 0 {
            return None;
        }
        let info = self.checker.sym(SymbolId(symbol));
        let name = info.name.to_string();
        if !matches!(
            name.as_str(),
            "Error" | "TypeError" | "RangeError" | "SyntaxError"
        ) || !info.declarations.iter().any(|n| {
            !n.is_nil()
                && source_file_info(get_source_file_of_node(*n))
                    .file_name
                    .ends_with("/lib.es5.d.ts")
        }) {
            return None;
        }
        // Install the complete builtin prefix once. Source recognition still
        // requires declaration identity; a user-defined Error is never ambient.
        for builtin in ["Error", "TypeError", "RangeError", "SyntaxError"] {
            let ir_name = format!("%{builtin}");
            if self.classes.definitions.iter().any(|d| d.name == ir_name) {
                continue;
            }
            let base = if builtin == "Error" {
                None
            } else {
                self.classes
                    .definitions
                    .iter()
                    .position(|d| d.name == "%Error")
            };
            self.classes.definitions.push(Definition {
                node: Node::NIL,
                name: ir_name.clone(),
                file: "<builtin>".into(),
                base,
                resolved: true,
                resolving: false,
                signature: None,
                token: None,
            });
            self.classes.layouts.push(Some(ir::Class {
                name: ir_name,
                js_name: builtin.into(),
                runtime: true,
                base: base.map(|i| self.classes.definitions[i].name.clone()),
                fields: ir::error_fields(),
                loc: Loc {
                    file: "<builtin>".into(),
                    start: 0,
                    end: 0,
                },
            }));
        }
        let index = self
            .classes
            .definitions
            .iter()
            .position(|d| d.name == format!("%{name}"))?;
        self.classes.symbols.insert(symbol, index);
        Some(index)
    }

    fn class_symbol(&mut self, node: Node) -> Option<usize> {
        if node.kind() != SyntaxKind::Identifier
            && !(node.kind() == SyntaxKind::PropertyAccessExpression
                && self.module_namespace(node.expression()))
        {
            return None;
        }
        let symbol = self.symbol(if node.kind() == SyntaxKind::PropertyAccessExpression {
            node.name()
        } else {
            node
        });
        self.builtin_class(symbol)
    }

    fn resolve_class(&mut self, index: usize) -> Result<(), String> {
        let result = self.resolve_class_inner(index);
        self.classes.definitions[index].resolving = false;
        result
    }

    fn resolve_class_inner(&mut self, index: usize) -> Result<(), String> {
        let definition = self.classes.definitions[index].clone();
        if definition.resolved {
            return Ok(());
        }
        if definition.resolving {
            return Err(self.refuse(definition.node, "cyclic class inheritance is not ported"));
        }
        self.classes.definitions[index].resolving = true;
        let node = definition.node;
        if node.name().is_nil()
            || !node.type_parameters().is_empty()
            || node
                .modifier_flags()
                .intersects(ModifierFlags::ABSTRACT | ModifierFlags::AMBIENT)
            || node
                .modifiers()
                .nodes()
                .into_iter()
                .any(|m| m.kind() == SyntaxKind::Decorator)
        {
            return Err(self.refuse(
                node,
                "only named concrete non-generic undecorated Error classes are ported",
            ));
        }
        let mut base = None;
        for clause in node.heritage_clauses().nodes() {
            if clause.token() != SyntaxKind::ExtendsKeyword {
                continue;
            }
            let types = clause.types().nodes().into_iter().collect::<Vec<_>>();
            if types.len() != 1 {
                return Err(self.refuse(node, "one Error base is required"));
            }
            let expression = types[0].expression();
            if expression.kind() != SyntaxKind::Identifier
                && !(expression.kind() == SyntaxKind::PropertyAccessExpression
                    && self.module_namespace(expression.expression()))
            {
                return Err(self.refuse(expression, "effectful class heritage is not ported"));
            }
            base = self.class_symbol(expression);
        }
        let base = base.ok_or_else(|| {
            self.refuse(node, "only classes derived from native Error are ported")
        })?;
        self.resolve_class(base)?;
        for member in node.members() {
            if member.modifier_flags().intersects(ModifierFlags::STATIC)
                || member
                    .modifiers()
                    .nodes()
                    .into_iter()
                    .any(|m| m.kind() == SyntaxKind::Decorator)
                || (member.kind() != SyntaxKind::Constructor
                    && (member.kind() != SyntaxKind::PropertyDeclaration
                        || !matches!(
                            member.name().kind(),
                            SyntaxKind::Identifier | SyntaxKind::StringLiteral
                        )))
            {
                return Err(self.refuse(
                    member,
                    "class methods, static/computed fields and decorators are not ported",
                ));
            }
        }
        self.classes.definitions[index].base = Some(base);
        self.classes.definitions[index].resolved = true;
        self.classes.definitions[index].resolving = false;
        Ok(())
    }

    pub(super) fn class_declaration(&mut self, node: Node) -> Result<Vec<Stmt>, String> {
        if self.return_type.is_some() || node.parent().kind() != SyntaxKind::SourceFile {
            return Err(self.refuse(node, "local class declarations are not ported"));
        }
        let index = self
            .class_symbol(node.name())
            .ok_or_else(|| self.refuse(node, "class has no native identity"))?;
        self.resolve_class(index)?;
        let mut body = Vec::new();
        if let Some(base) = self.classes.definitions[index].base
            && let Some(token) = self.classes.definitions[base].token.clone()
        {
            body.push(Stmt::Expression {
                expr: self.read_class_token(&token, node),
                loc: self.loc(node),
            });
        }
        let token = self.classes.definitions[index].token.as_ref().unwrap();
        body.push(Stmt::Assign {
            local_id: token.id.clone(),
            initializes_global: true,
            value: Expr::NumLit {
                value: 1.0,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(node),
            },
            loc: self.loc(node),
        });
        Ok(body)
    }

    fn layout_class(&mut self, index: usize) -> Result<(), String> {
        if self.classes.layouts[index].is_some() {
            return Ok(());
        }
        self.classes.layout_active.insert(index);
        let result = self.layout_class_inner(index);
        self.classes.layout_active.remove(&index);
        if result.is_err() {
            self.classes.layouts[index] = None;
        }
        result
    }

    fn layout_class_inner(&mut self, index: usize) -> Result<(), String> {
        self.resolve_class(index)?;
        let definition = self.classes.definitions[index].clone();
        let base = definition.base.unwrap();
        self.layout_class(base)?;
        let mut layout = ir::Class {
            name: definition.name,
            js_name: definition.node.name().text().into(),
            runtime: false,
            base: Some(self.classes.definitions[base].name.clone()),
            fields: self.classes.layouts[base].as_ref().unwrap().fields.clone(),
            loc: Loc {
                file: definition.file,
                start: definition.node.pos().max(0),
                end: definition.node.end(),
            },
        };
        for field in definition.node.members() {
            if field.kind() != SyntaxKind::PropertyDeclaration {
                continue;
            }
            let name = field.name().text().to_string();
            let ty = self.ty(field.name())?;
            let ty = if matches!(name.as_str(), "name" | "message") {
                ty
            } else {
                if matches!(
                    ty,
                    Type::Func { .. } | Type::Void | Type::Undefined | Type::Null
                ) {
                    return Err(self.refuse(field, "class field type is not ported"));
                }
                let mut arms = if let Type::Union { union_id } = ty {
                    self.unions[union_id].arms.clone()
                } else {
                    vec![ty]
                };
                arms.push(Type::Undefined);
                self.intern_union(arms).ok_or_else(|| {
                    self.refuse(field, "class field has no undefined representation")
                })?
            };
            if let Some(inherited) = layout.fields.iter().find(|f| f.name == name) {
                if inherited.r#type != ty
                    || (matches!(name.as_str(), "name" | "message")
                        && field.initializer().is_nil()
                        && !field.modifier_flags().intersects(ModifierFlags::AMBIENT))
                {
                    return Err(self.refuse(
                        field,
                        "field override layout/undefined initialization is not ported",
                    ));
                }
            } else {
                layout.fields.push(ir::Field { name, r#type: ty });
            }
        }
        self.classes.layouts[index] = Some(layout);
        Ok(())
    }

    pub(super) fn class_type(&mut self, id: TypeId) -> Option<Type> {
        if !self
            .checker
            .get_signatures_of_type(id, SignatureKind::CONSTRUCT)
            .is_empty()
        {
            return None;
        }
        let symbol = self.checker.ty(id).symbol().0;
        let index = self.builtin_class(symbol)?;
        if self.classes.layout_active.contains(&index) {
            return Some(self.classes.object(index));
        }
        self.layout_class(index).ok()?;
        Some(self.classes.object(index))
    }
}

mod constructors;
mod values;
