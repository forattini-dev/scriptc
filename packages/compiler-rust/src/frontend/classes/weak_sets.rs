//! WeakSet identity owns a hidden WeakMap table; its keys remain non-owning.
use super::*;
use helpers::Helper;

pub(in crate::frontend) const CLASS: &str = "native_builtin_WeakSet";
const DATA: &str = "[[WeakSetData]]";
pub(in crate::frontend) fn instance(ty: &Type) -> bool {
    matches!(ty, Type::Object { class_name } if class_name == CLASS)
}
fn owner_type() -> Type {
    Type::Object {
        class_name: CLASS.into(),
    }
}
fn table_type() -> Type {
    Type::Object {
        class_name: weak_maps::CLASS.into(),
    }
}
fn operation(name: &str, args: Vec<Expr>, ty: Type, loc: &Loc) -> Expr {
    Expr::LibCall {
        r#fn: name.into(),
        args,
        r#type: ty,
        loc: loc.clone(),
    }
}
impl Lowerer<'_> {
    pub(in crate::frontend) fn standard_weak_set(&self, symbol: u32) -> bool {
        if symbol == 0 {
            return false;
        }
        let symbol = self.checker.sym(SymbolId(symbol));
        symbol.name.as_ref() == "WeakSet"
            && symbol.declarations.iter().any(|decl| {
                let file = source_file_info(get_source_file_of_node(*decl));
                source_frontend::frontend::bundled::bundled_lib_name(&file.file_name)
                    == Some("lib.es2015.collection.d.ts")
            })
    }
    pub(super) fn weak_set_class(&mut self, site: Node) -> usize {
        if let Some(index) = self
            .classes
            .definitions
            .iter()
            .position(|d| d.name == CLASS)
        {
            return index;
        }
        self.private_table_constructor(site)
            .expect("internal weak storage constructor");
        let index = self.classes.definitions.len();
        self.classes.definitions.push(Definition {
            node: Node::NIL,
            name: CLASS.into(),
            file: "<builtin>".into(),
            base: None,
            resolved: true,
            resolving: false,
            signature: None,
            token: None,
            captures: Vec::new(),
        });
        self.classes.layouts.push(Some(ir::Class {
            name: CLASS.into(),
            js_name: "WeakSet".into(),
            runtime: false,
            base: None,
            fields: vec![ir::Field {
                name: DATA.into(),
                r#type: Type::Dyn,
            }],
            captures: vec![],
            methods: vec![],
            symbol_methods: vec![],
            symbol_brand: None,
            method_names: vec!["add".into(), "has".into(), "delete".into()],
            loc: self.loc(site),
        }));
        index
    }
    pub(super) fn weak_set_constructor(&self, index: usize) -> Function {
        let mut helper = Helper::new(
            &format!("%{CLASS}.constructor"),
            vec![owner_type()],
            Type::Void,
            self.classes.layouts[index].as_ref().unwrap().loc.clone(),
        );
        // Only this internal slot erases the table. Source WeakMap/WeakSet
        // erasure stays fenced, so descriptors and methods cannot be invented.
        helper.function.body.push(Stmt::FieldSet {
            obj: helper.read(&helper.param(0)),
            class_name: CLASS.into(),
            field: DATA.into(),
            value: Expr::DynFrom {
                value: Box::new(Expr::New {
                    class_name: weak_maps::CLASS.into(),
                    args: vec![],
                    r#type: table_type(),
                    loc: helper.loc(),
                }),
                r#type: Type::Dyn,
                loc: helper.loc(),
            },
            loc: helper.loc(),
        });
        helper.function
    }
    fn weak_set_key(&self, ty: &Type) -> bool {
        match ty {
            Type::Dyn | Type::F64 | Type::Bool | Type::String | Type::Null | Type::Undefined => {
                true
            }
            Type::Record { shape_id } => {
                !self.records[*shape_id].tuple
                    && self.records[*shape_id].index_value.is_none()
                    && !self.enum_shape(*shape_id)
                    && !self.callables.contains_key(shape_id)
            }
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .all(|t| self.weak_set_key(t)),
            _ => false,
        }
    }
    fn weak_set_operation(&mut self, method: &str, site: Node) -> Result<String, String> {
        let ret = if method == "add" {
            Type::Void
        } else {
            Type::Bool
        };
        let mut helper = Helper::new(
            &format!("weak_set_{method}"),
            vec![owner_type(), Type::Dyn],
            ret.clone(),
            self.loc(site),
        );
        if method == "add" {
            self.ensure_exception_classes(site)?;
            let mut invalid = None;
            for test in ["nullish", "number", "boolean", "string"] {
                let cond = Expr::DynTest {
                    value: Box::new(helper.read(&helper.param(1))),
                    test: test.into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                };
                invalid = Some(match invalid {
                    None => cond,
                    Some(left) => Expr::Logical {
                        op: "||".into(),
                        left: Box::new(left),
                        right: Box::new(cond),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                });
            }
            helper.function.body.push(Stmt::If {
                cond: invalid.unwrap(),
                then: vec![Stmt::Throw {
                    value: operation(
                        "error.new",
                        vec![Expr::StrLit {
                            value: "Invalid value used in weak set".into(),
                            r#type: Type::String,
                            loc: helper.loc(),
                        }],
                        Type::Object {
                            class_name: "%TypeError".into(),
                        },
                        &helper.loc(),
                    ),
                    loc: helper.loc(),
                }],
                else_: None,
                loc: helper.loc(),
            });
        }
        let table = Expr::FieldGet {
            obj: Box::new(helper.read(&helper.param(0))),
            class_name: CLASS.into(),
            field: DATA.into(),
            r#type: Type::Dyn,
            loc: helper.loc(),
        };
        let table = self.coerce(table, table_type(), site)?;
        let mut args = vec![table, helper.read(&helper.param(1))];
        if method == "add" {
            args.push(Expr::DynFrom {
                value: Box::new(Expr::BoolLit {
                    value: true,
                    r#type: Type::Bool,
                    loc: helper.loc(),
                }),
                r#type: Type::Dyn,
                loc: helper.loc(),
            });
        }
        let op = operation(
            &format!("weakmap.{}", if method == "add" { "set" } else { method }),
            args,
            ret,
            &helper.loc(),
        );
        helper.function.body.push(if method == "add" {
            Stmt::Expression {
                expr: op,
                loc: helper.loc(),
            }
        } else {
            Stmt::Return {
                value: Some(op),
                loc: helper.loc(),
            }
        });
        Ok(self.install_helper(helper.function))
    }
    pub(in crate::frontend) fn weak_set_call(
        &mut self,
        node: Node,
    ) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression
            || !self
                .ty(member.expression())
                .ok()
                .as_ref()
                .is_some_and(instance)
        {
            return Ok(None);
        }
        let method = member.name().text();
        if !matches!(method, "add" | "has" | "delete") {
            return Err(self.refuse(node, "WeakSet member is not ported"));
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args
            .iter()
            .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "WeakSet argument spreads are not ported"));
        }
        let receiver = self.expression(member.expression())?;
        let key = match args.first() {
            Some(arg) => {
                let value = self.expression(*arg)?;
                self.primitive_capture(value, *arg)?
            }
            None => Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            },
        };
        if !self.weak_set_key(&key.ty()) {
            return Err(self.refuse(node, "WeakSet keys require closed data records; other object and symbol keys are not ported"));
        }
        let mut values = vec![receiver, self.coerce(key, Type::Dyn, node)?];
        for arg in args.iter().skip(1) {
            let value = self.expression(*arg)?;
            let value = self.primitive_capture(value, *arg)?;
            values.push(self.coerce(value, Type::Dyn, *arg)?);
        }
        let ret = if method == "add" {
            owner_type()
        } else {
            Type::Bool
        };
        let mut helper = Helper::new(
            &format!("weak_set_call_{method}"),
            values.iter().map(Expr::ty).collect(),
            ret.clone(),
            self.loc(node),
        );
        let call = Expr::Call {
            callee: self.weak_set_operation(method, node)?,
            args: vec![helper.read(&helper.param(0)), helper.read(&helper.param(1))],
            r#type: if method == "add" {
                Type::Void
            } else {
                Type::Bool
            },
            loc: helper.loc(),
        };
        let result = if method == "add" {
            helper.function.body.push(Stmt::Expression {
                expr: call,
                loc: helper.loc(),
            });
            helper.read(&helper.param(0))
        } else {
            call
        };
        helper.function.body.push(Stmt::Return {
            value: Some(result),
            loc: helper.loc(),
        });
        Ok(Some(Expr::Call {
            callee: self.install_helper(helper.function),
            args: values,
            r#type: ret,
            loc: self.loc(node),
        }))
    }
    fn weak_set_seed_type(&self, ty: &Type) -> bool {
        match ty {
            Type::Null | Type::Undefined => true,
            Type::Array { elem } => self.weak_set_key(elem),
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .all(|t| self.weak_set_seed_type(t)),
            _ => false,
        }
    }
    fn weak_set_seed_body(
        &mut self,
        helper: &mut Helper,
        seed: Expr,
        owner: &Local,
        site: Node,
    ) -> Result<Vec<Stmt>, String> {
        match seed.ty() {
            Type::Null | Type::Undefined => Ok(vec![]),
            Type::Union { union_id } => {
                let mut body = vec![];
                for (tag, arm) in self.unions[union_id].arms.clone().into_iter().enumerate() {
                    let value = Expr::UnionNarrow {
                        union_id: format!("u{union_id}"),
                        tag,
                        value: Box::new(seed.clone()),
                        r#type: arm,
                        loc: helper.loc(),
                    };
                    let then = self.weak_set_seed_body(helper, value, owner, site)?;
                    if !then.is_empty() {
                        body.push(Stmt::If {
                            cond: Expr::UnionIsTag {
                                union_id: format!("u{union_id}"),
                                tag,
                                value: Box::new(seed.clone()),
                                negated: false,
                                r#type: Type::Bool,
                                loc: helper.loc(),
                            },
                            then,
                            else_: None,
                            loc: helper.loc(),
                        });
                    }
                }
                Ok(body)
            }
            Type::Array { elem } => {
                let input = helper.local("seed", seed.ty(), false);
                let index = helper.local("index", Type::F64, true);
                let value = self.coerce(helper.get(&input, &index, *elem), Type::Dyn, site)?;
                Ok(vec![
                    Stmt::VarDecl {
                        local_id: input.id.clone(),
                        init: seed,
                        loc: helper.loc(),
                    },
                    Stmt::VarDecl {
                        local_id: index.id.clone(),
                        init: helper.number(0.0),
                        loc: helper.loc(),
                    },
                    Stmt::While {
                        cond: helper.less(&index, helper.length(&input)),
                        body: vec![
                            Stmt::Expression {
                                expr: Expr::Call {
                                    callee: self.weak_set_operation("add", site)?,
                                    args: vec![helper.read(owner), value],
                                    r#type: Type::Void,
                                    loc: helper.loc(),
                                },
                                loc: helper.loc(),
                            },
                            helper.advance(&index),
                        ],
                        loc: helper.loc(),
                    },
                ])
            }
            _ => unreachable!("seed representation was checked before helper construction"),
        }
    }
    pub(super) fn weak_set_new(&mut self, node: Node, index: usize) -> Result<Expr, String> {
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args
            .iter()
            .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "WeakSet constructor argument spreads are not ported"));
        }
        let mut values = vec![];
        for (index, arg) in args.iter().enumerate() {
            let value = if index == 0 && arg.kind() == SyntaxKind::ArrayLiteralExpression {
                for element in arg.elements() {
                    if element.kind() != SyntaxKind::SpreadElement {
                        let ty = self.ty(element)?;
                        if !self.weak_set_key(&ty) {
                            return Err(self.refuse(element, "WeakSet seed elements require represented data keys; other object and symbol keys are not ported"));
                        }
                    }
                }
                self.expected_expression(
                    *arg,
                    Type::Array {
                        elem: Box::new(Type::Dyn),
                    },
                )?
            } else {
                self.expression(*arg)?
            };
            let value = if index == 0 {
                // Unit tags need a carrier ABI. Use the actual seed family,
                // rather than introducing a spurious numeric iterable arm.
                if matches!(value.ty(), Type::Null | Type::Undefined | Type::Void) {
                    let ty = self
                        .intern_union(vec![
                            Type::Array {
                                elem: Box::new(Type::Dyn),
                            },
                            Type::Null,
                            Type::Undefined,
                        ])
                        .unwrap();
                    if value.ty() == Type::Void {
                        let unit = Expr::UnitLit {
                            unit: "undefined",
                            r#type: Type::Undefined,
                            loc: self.loc(*arg),
                        };
                        Expr::Sequence {
                            stmts: vec![Stmt::Expression {
                                expr: value,
                                loc: self.loc(*arg),
                            }],
                            result: Box::new(self.coerce(unit, ty.clone(), *arg)?),
                            r#type: ty,
                            loc: self.loc(*arg),
                        }
                    } else {
                        self.coerce(value, ty, *arg)?
                    }
                } else {
                    value
                }
            } else {
                let value = self.primitive_capture(value, *arg)?;
                self.coerce(value, Type::Dyn, *arg)?
            };
            values.push(value);
        }
        if values
            .first()
            .is_some_and(|v| !self.weak_set_seed_type(&v.ty()))
        {
            return Err(self.refuse(node, "WeakSet seeds require a represented dense array or nullish value; custom iterators are not ported"));
        }
        self.request_constructor(index)?;
        let mut helper = Helper::new(
            "weak_set_new",
            values.iter().map(Expr::ty).collect(),
            owner_type(),
            self.loc(node),
        );
        let owner = helper.local("owner", owner_type(), false);
        helper.declare(
            &owner,
            Expr::New {
                class_name: CLASS.into(),
                args: vec![],
                r#type: owner_type(),
                loc: helper.loc(),
            },
        );
        if !values.is_empty() {
            let seed = helper.read(&helper.param(0));
            let body = self.weak_set_seed_body(&mut helper, seed, &owner, node)?;
            helper.function.body.extend(body);
        }
        Ok(Expr::Call {
            callee: self.install_helper(helper.finish(&owner)),
            args: values,
            r#type: owner_type(),
            loc: self.loc(node),
        })
    }
}
