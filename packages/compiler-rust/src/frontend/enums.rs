//! Compiled enum namespaces retain their hoisted slot and ordered writes.
use super::*;

#[derive(Clone)]
struct Entry {
    key: String,
    value: Value,
}
#[derive(Clone)]
enum Value {
    Number(f64),
    String(String),
}
impl Value {
    fn ty(&self) -> Type {
        match self {
            Self::Number(_) => Type::F64,
            Self::String(_) => Type::String,
        }
    }
    fn expr(&self, loc: Loc) -> Expr {
        match self {
            Self::Number(value) => Expr::NumLit {
                value: *value,
                spelling: None,
                r#type: Type::F64,
                loc,
            },
            Self::String(value) => Expr::StrLit {
                value: value.clone(),
                r#type: Type::String,
                loc,
            },
        }
    }
}
#[derive(Clone)]
struct Definition {
    symbol: u32,
    shape: usize,
    entries: Vec<Entry>,
}
#[derive(Default)]
pub(super) struct EnumGraph {
    statements: HashMap<declarations::Key, Definition>,
    bindings: HashMap<u32, usize>,
    members: HashMap<usize, HashMap<String, Type>>,
}

fn unwrap(mut node: Node) -> Node {
    while !node.is_nil() && node.kind() == SyntaxKind::ParenthesizedExpression {
        node = node.expression();
    }
    node
}
fn assignment(node: Node) -> bool {
    !node.is_nil()
        && node.kind() == SyntaxKind::BinaryExpression
        && node.operator_token().kind() == SyntaxKind::EqualsToken
}
fn literal(node: Node) -> Option<Value> {
    match node.kind() {
        SyntaxKind::NumericLiteral => Some(Value::Number(
            source_frontend::jsnum::from_string(&node.text().replace('_', "")).value(),
        )),
        SyntaxKind::StringLiteral => {
            let bytes = source_frontend::scanner_util::go_string_bytes(node.text());
            Some(Value::String(std::str::from_utf8(&bytes).ok()?.into()))
        }
        SyntaxKind::PrefixUnaryExpression if node.operator() == SyntaxKind::MinusToken => {
            if let Value::Number(n) = literal(node.operand())? {
                Some(Value::Number(-n))
            } else {
                None
            }
        }
        _ => None,
    }
}

impl Lowerer<'_> {
    fn enum_member(&mut self, node: Node, param: u32) -> Option<String> {
        if node.kind() != SyntaxKind::ElementAccessExpression
            || self.symbol(node.expression()) != param
        {
            return None;
        }
        match literal(node.argument_expression())? {
            Value::String(key) if key != "__proto__" => Some(key),
            _ => None,
        }
    }

    fn compiled_enum(&mut self, statement: Node) -> Option<(u32, Vec<Entry>)> {
        if statement.kind() != SyntaxKind::ExpressionStatement {
            return None;
        }
        let call = unwrap(statement.expression());
        if call.kind() != SyntaxKind::CallExpression || call.arguments().len() != 1 {
            return None;
        }
        let function = unwrap(call.expression());
        if function.kind() != SyntaxKind::FunctionExpression
            || !function.name().is_nil()
            || function.parameters().len() != 1
            || !function.type_parameters().is_empty()
            || !function.asterisk_token().is_nil()
            || function.modifier_flags().intersects(ModifierFlags::ASYNC)
        {
            return None;
        }
        let parameter = function.parameters().into_iter().next()?;
        if parameter.name().kind() != SyntaxKind::Identifier
            || !parameter.initializer().is_nil()
            || !parameter.dot_dot_dot_token().is_nil()
        {
            return None;
        }
        let argument = unwrap(call.arguments().into_iter().next()?);
        if argument.kind() != SyntaxKind::BinaryExpression
            || argument.operator_token().kind() != SyntaxKind::BarBarToken
        {
            return None;
        }
        let original = argument.left();
        if original.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(original);
        if symbol == 0 {
            return None;
        }
        let init = unwrap(argument.right());
        if !assignment(init) || self.symbol(init.left()) != symbol {
            return None;
        }
        let object = init.right();
        if object.kind() != SyntaxKind::ObjectLiteralExpression || !object.properties().is_empty() {
            return None;
        }
        let param = self.symbol(parameter.name());
        let mut entries = Vec::new();
        for statement in function.body().statements() {
            if statement.kind() != SyntaxKind::ExpressionStatement {
                return None;
            }
            let write = statement.expression();
            if !assignment(write) {
                return None;
            }
            if let Some(key) = self.enum_member(write.left(), param) {
                let value = literal(write.right())?;
                if !matches!(value, Value::String(_)) {
                    return None;
                }
                entries.push(Entry { key, value });
            } else {
                let outer = write.left();
                if outer.kind() != SyntaxKind::ElementAccessExpression
                    || self.symbol(outer.expression()) != param
                {
                    return None;
                }
                let inner = outer.argument_expression();
                if !assignment(inner) {
                    return None;
                }
                let key = self.enum_member(inner.left(), param)?;
                let Value::Number(value) = literal(inner.right())? else {
                    return None;
                };
                let Value::String(reverse) = literal(write.right())? else {
                    return None;
                };
                if reverse != key
                    || !value.is_finite()
                    || value.fract() != 0.0
                    || value.abs() > 9_007_199_254_740_991.0
                {
                    return None;
                }
                entries.push(Entry {
                    key: key.clone(),
                    value: Value::Number(value),
                });
                entries.push(Entry {
                    key: if value == 0.0 {
                        "0".into()
                    } else {
                        format!("{value:.0}")
                    },
                    value: Value::String(key),
                });
            }
        }
        (!entries.is_empty()).then_some((symbol, entries))
    }

    pub(super) fn inventory_enums(&mut self, files: &[Node]) -> Result<(), String> {
        for file in files {
            for statement in file.statements() {
                let Some((symbol, entries)) = self.compiled_enum(statement) else {
                    continue;
                };
                // Only the module's own bare var may be initialized here.
                let declaration = self
                    .checker
                    .sym(source_frontend::prelude::SymbolId(symbol))
                    .value_declaration;
                if declaration.is_nil()
                    || declaration.kind() != SyntaxKind::VariableDeclaration
                    || !declaration.initializer().is_nil()
                    || declaration
                        .parent()
                        .flags()
                        .intersects(NodeFlags::LET | NodeFlags::CONST)
                    || declaration.parent().parent().parent() != *file
                {
                    continue;
                }
                let shape = if let Some(shape) = self.enums.bindings.get(&symbol) {
                    *shape
                } else {
                    let value = self
                        .intern_union(vec![Type::F64, Type::String, Type::Undefined])
                        .unwrap();
                    let id = self.records.len();
                    self.records.push(ir::Record {
                        id,
                        fields: vec![],
                        declared_order: vec![],
                        tuple: false,
                        index_value: Some(value),
                    });
                    self.enums.bindings.insert(symbol, id);
                    id
                };
                let members = self.enums.members.entry(shape).or_default();
                for entry in &entries {
                    if members
                        .get(&entry.key)
                        .is_some_and(|previous| *previous != entry.value.ty())
                    {
                        return Err(self.refuse(
                            statement,
                            "enum key collisions with different value kinds are not ported",
                        ));
                    }
                    members.insert(entry.key.clone(), entry.value.ty());
                }
                self.enums.statements.insert(
                    declarations::Key::of(statement),
                    Definition {
                        symbol,
                        shape,
                        entries,
                    },
                );
            }
        }
        Ok(())
    }

    pub(super) fn enum_type(&mut self, node: Node) -> Option<Type> {
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(node);
        self.enums
            .bindings
            .get(&symbol)
            .map(|shape| Type::Record { shape_id: *shape })
    }

    pub(super) fn enum_statement(&mut self, node: Node) -> Result<Option<Vec<Stmt>>, String> {
        let Some(definition) = self
            .enums
            .statements
            .get(&declarations::Key::of(node))
            .cloned()
        else {
            return Ok(None);
        };
        let binding = self.module_bindings[&definition.symbol].clone();
        let ty = Type::Record {
            shape_id: definition.shape,
        };
        let Type::Union { union_id } = binding.r#type else {
            return Err(self.refuse(node, "enum needs a hoisted undefined slot"));
        };
        let tag = self.unions[union_id]
            .arms
            .iter()
            .position(|a| *a == ty)
            .unwrap();
        let read = || Expr::VarRef {
            local_id: binding.id.clone(),
            r#type: Type::Union { union_id },
            loc: self.loc(node),
        };
        let namespace = Expr::Ternary {
            cond: Box::new(Expr::UnionIsTag {
                union_id: format!("u{union_id}"),
                tag,
                negated: false,
                value: Box::new(read()),
                r#type: Type::Bool,
                loc: self.loc(node),
            }),
            then: Box::new(Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(read()),
                r#type: ty.clone(),
                loc: self.loc(node),
            }),
            else_: Box::new(Expr::RecordLit {
                fields: vec![],
                r#type: ty.clone(),
                loc: self.loc(node),
            }),
            r#type: ty.clone(),
            loc: self.loc(node),
        };
        let local = Local {
            id: format!("v{}", self.locals.len()),
            name: "enum_namespace".into(),
            r#type: ty.clone(),
            mutable: false,
            boxed: false,
        };
        self.locals.push(local.clone());
        let mut body = vec![Stmt::VarDecl {
            local_id: local.id.clone(),
            init: namespace,
            loc: self.loc(node),
        }];
        body.push(Stmt::Assign {
            local_id: binding.id,
            initializes_global: false,
            value: self.coerce(
                Expr::VarRef {
                    local_id: local.id.clone(),
                    r#type: ty.clone(),
                    loc: self.loc(node),
                },
                Type::Union { union_id },
                node,
            )?,
            loc: self.loc(node),
        });
        let value_type = self.records[definition.shape].index_value.clone().unwrap();
        for entry in definition.entries {
            body.push(Stmt::RecordKeySet {
                obj: Expr::VarRef {
                    local_id: local.id.clone(),
                    r#type: ty.clone(),
                    loc: self.loc(node),
                },
                shape_id: format!("r{}", definition.shape),
                key: Expr::StrLit {
                    value: entry.key,
                    r#type: Type::String,
                    loc: self.loc(node),
                },
                value: self.coerce(entry.value.expr(self.loc(node)), value_type.clone(), node)?,
                overflow_only: true,
                loc: self.loc(node),
            });
        }
        self.var_defined.insert(definition.symbol);
        Ok(Some(body))
    }

    pub(super) fn enum_get(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let ty = self.ty(node.expression()).ok().or_else(|| {
            let symbol = self.symbol(node.expression());
            self.bindings
                .get(&symbol)
                .or_else(|| self.module_bindings.get(&symbol))
                .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                .map(|l| l.r#type.clone())
        });
        let shape_id = match ty {
            Some(Type::Record { shape_id }) => shape_id,
            Some(Type::Union { union_id }) => {
                let Some(shape) = self.unions[union_id].arms.iter().find_map(|arm| match arm {
                    Type::Record { shape_id } if self.enum_shape(*shape_id) => Some(*shape_id),
                    _ => None,
                }) else {
                    return Ok(None);
                };
                shape
            }
            _ => return Ok(None),
        };
        let Some(members) = self.enums.members.get(&shape_id) else {
            return Ok(None);
        };
        let key = if node.kind() == SyntaxKind::PropertyAccessExpression {
            node.name().text().to_string()
        } else {
            match literal(node.argument_expression()) {
                Some(Value::String(key)) => key,
                Some(Value::Number(value))
                    if value.is_finite()
                        && value.fract() == 0.0
                        && value.abs() <= 9_007_199_254_740_991.0 =>
                {
                    if value == 0.0 {
                        "0".into()
                    } else {
                        format!("{value:.0}")
                    }
                }
                _ => return Err(self.refuse(node, "dynamic enum keys are not ported")),
            }
        };
        let target = members.get(&key).cloned();
        let mut obj = self.expression(node.expression())?;
        if let Type::Union { union_id } = obj.ty() {
            let ty = Type::Record { shape_id };
            let tag = self.unions[union_id]
                .arms
                .iter()
                .position(|a| *a == ty)
                .ok_or_else(|| self.refuse(node, "enum receiver needs its namespace arm"))?;
            obj = Expr::UnionNarrow {
                union_id: format!("u{union_id}"),
                tag,
                value: Box::new(obj),
                r#type: ty,
                loc: self.loc(node),
            };
        }
        let value_type = self.records[shape_id].index_value.clone().unwrap();
        let value = Expr::RecordKeyGet {
            obj: Box::new(obj),
            shape_id: format!("r{shape_id}"),
            key: Box::new(Expr::StrLit {
                value: key,
                r#type: Type::String,
                loc: self.loc(node),
            }),
            overflow_only: true,
            r#type: value_type.clone(),
            loc: self.loc(node),
        };
        let Some(target) = target else {
            return Ok(Some(value));
        };
        let Type::Union { union_id } = value_type else {
            unreachable!()
        };
        let tag = self.unions[union_id]
            .arms
            .iter()
            .position(|a| *a == target)
            .unwrap();
        Ok(Some(Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag,
            value: Box::new(value),
            r#type: target,
            loc: self.loc(node),
        }))
    }

    pub(super) fn enum_shape(&self, shape: usize) -> bool {
        self.enums.members.contains_key(&shape)
    }
}
