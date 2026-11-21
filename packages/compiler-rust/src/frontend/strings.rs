//! Cooked templates and dense array joins lower to portable string operations.
use super::*;
use helpers::Helper;

#[cfg(test)]
mod tests {
    #[test]
    fn invalid_tag_escape_rejects_undefined_losing_array_views() {
        std::thread::Builder::new()
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                let input = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../tests/fixtures/tagged-template/invalid-typed.ts")
                    .canonicalize()
                    .unwrap();
                let work = tempfile::Builder::new()
                    .prefix("scriptc-template-invalid-")
                    .tempdir()
                    .unwrap();
                let error = match crate::frontend::lower(&input, work.path(), None, false) {
                    Ok(_) => panic!("typed views cannot preserve undefined cooked entries"),
                    Err(error) => error,
                };
                assert!(
                    error.contains("undefined-preserving typed array views"),
                    "{error}"
                );
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn template_strings_array_with_undefined_is_not_silently_projected_to_string() {
        std::thread::Builder::new()
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                let input = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../tests/fixtures/tagged-template/undefined-slot.ts")
                    .canonicalize()
                    .unwrap();
                let work = tempfile::Builder::new()
                    .prefix("scriptc-template-undefined-")
                    .tempdir()
                    .unwrap();
                let error = match crate::frontend::lower(&input, work.path(), None, false) {
                    Ok(_) => {
                        panic!("undefined cooked entries require a faithful native representation")
                    }
                    Err(error) => error,
                };
                assert!(error.contains("type has no representation"), "{error}");
            })
            .unwrap()
            .join()
            .unwrap();
    }
}

#[derive(Clone, Copy)]
pub(super) enum Context {
    Template,
    Element,
    Separator,
}

impl Lowerer<'_> {
    pub(super) fn string_addition(
        &mut self,
        left: Expr,
        right: Expr,
        node: Node,
    ) -> Result<Expr, String> {
        // A typed record or array view may expose a value asserted non-null by
        // the checker while its owner still contains undefined (for example
        // after a getter changes or a Map lookup misses). JavaScript converts
        // the actual value during addition, not the projected static value.
        let left = self
            .raw_record_field(&left, node.left())
            .or_else(|| self.raw_array_element(&left, node.left()))
            .or_else(|| self.raw_primitive_projection(&left))
            .unwrap_or(left);
        let right = self
            .raw_record_field(&right, node.right())
            .or_else(|| self.raw_array_element(&right, node.right()))
            .or_else(|| self.raw_primitive_projection(&right))
            .unwrap_or(right);
        if left.ty() == Type::String && right.ty() == Type::String {
            return Ok(self.string_concat(left, right, node));
        }
        for ty in [left.ty(), right.ty()] {
            if self.native_type_contains(&ty, |ty| {
                !matches!(
                    ty,
                    Type::String
                        | Type::Bigint
                        | Type::F64
                        | Type::Bool
                        | Type::Null
                        | Type::Undefined
                        | Type::Void
                        | Type::Symbol
                        | Type::Dyn
                        | Type::Caught
                        | Type::Union { .. }
                )
            }) {
                return Err(
                    self.refuse(node, "object ToPrimitive for string addition is not ported")
                );
            }
        }
        self.ensure_exception_classes(node)?;
        let capture = |value: Expr, site: Node| {
            if value.ty() == Type::Caught {
                Ok(Expr::CaughtToDyn {
                    value: Box::new(value),
                    r#type: Type::Dyn,
                    loc: self.loc(site),
                })
            } else {
                self.coerce(value, Type::Dyn, site)
            }
        };
        // Both operand values are captured before ToString can throw. In
        // particular a left-hand Symbol must not suppress right-hand effects.
        let args = vec![capture(left, node.left())?, capture(right, node.right())?];
        let mut helper = Helper::new(
            "string_addition",
            vec![Type::Dyn, Type::Dyn],
            Type::String,
            self.loc(node),
        );
        let text = |index| Expr::ToString {
            operand: Box::new(helper.read(&helper.param(index))),
            r#type: Type::String,
            loc: helper.loc(),
        };
        let value = self.string_concat(text(0), text(1), node);
        helper.function.body.push(Stmt::Return {
            value: Some(value),
            loc: helper.loc(),
        });
        Ok(Expr::Call {
            callee: self.install_helper(helper.function),
            args,
            r#type: Type::String,
            loc: self.loc(node),
        })
    }

    fn string_literal(&self, value: &str, node: Node) -> Expr {
        Expr::StrLit {
            value: value.into(),
            r#type: Type::String,
            loc: self.loc(node),
        }
    }

    pub(super) fn string_concat(&self, left: Expr, right: Expr, node: Node) -> Expr {
        match (left, right) {
            // Template lowering deliberately preserves one concatenation per
            // source boundary so substitutions are converted in JavaScript
            // evaluation order. Empty cooked heads and tails have no
            // observable work of their own, however, and retaining them
            // allocates a second string in hot templates such as `key-${n}`.
            (Expr::StrLit { value, .. }, right) if value.is_empty() => right,
            (left, Expr::StrLit { value, .. }) if value.is_empty() => left,
            (
                Expr::StrLit {
                    value: mut left, ..
                },
                Expr::StrLit { value: right, .. },
            ) => {
                left.push_str(&right);
                self.string_literal(&left, node)
            }
            (left, right) => Expr::StrConcat {
                left: Box::new(left),
                right: Box::new(right),
                r#type: Type::String,
                loc: self.loc(node),
            },
        }
    }

    pub(super) fn template_expression(&mut self, node: Node) -> Result<Expr, String> {
        let cooked = |part: Node| -> Result<String, String> {
            let bytes = source_frontend::scanner_util::go_string_bytes(part.text());
            std::str::from_utf8(&bytes)
                .map(str::to_owned)
                .map_err(|_| self.refuse(part, "lone UTF-16 surrogates are not ported"))
        };
        let head = cooked(node.head())?;
        let spans = node
            .template_spans()
            .nodes()
            .into_iter()
            .map(|span| Ok((span.expression(), cooked(span.literal())?)))
            .collect::<Result<Vec<_>, String>>()?;
        let mut result = self.string_literal(&head, node);
        for (source, tail) in spans {
            let value = self.expression(source)?;
            let value = self.string_value(value, source, Context::Template)?;
            // Nested concatenation converts this substitution before the next
            // expression runs. Passing all substitutions to a helper would not.
            result = self.string_concat(result, value, node);
            result = self.string_concat(result, self.string_literal(&tail, node), node);
        }
        Ok(result)
    }

    fn template_raw_part(&self, part: Node) -> Result<String, String> {
        let raw = part.raw_text();
        let text = if raw.is_empty() {
            // The parser can leave RawText empty, including for a nonempty
            // no-substitution literal. Recover its spelling from the source,
            // as the frontend's own tagged-template transform does.
            let source = source_frontend::scanner_util::get_source_text_of_node_from_source_file(
                get_source_file_of_node(part),
                part,
                false,
            );
            let end = if matches!(
                part.kind(),
                SyntaxKind::NoSubstitutionTemplateLiteral | SyntaxKind::TemplateTail
            ) {
                "`"
            } else {
                "${"
            };
            source
                .strip_prefix(['`', '}'])
                .and_then(|source| source.strip_suffix(end))
                .ok_or_else(|| self.refuse(part, "template raw source spelling is unavailable"))?
                .to_owned()
        } else {
            raw.to_owned()
        };
        Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
    }

    pub(super) fn tagged_template_expression(&mut self, node: Node) -> Result<Expr, String> {
        use source_frontend::flags::TokenFlags;
        let tag = node.tag();
        let reference = receivers::reference_node(tag);
        let mut stmts = Vec::new();
        let (callee, receiver) = if matches!(
            reference.kind(),
            SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression
        ) {
            let source = reference.expression();
            let value = self.expression(source)?;
            let value = self.coerce(value, Type::Dyn, source)?;
            let receiver = self.update_temp(value, &mut stmts, source);
            let key = if reference.kind() == SyntaxKind::PropertyAccessExpression {
                self.string_literal(reference.name().text(), reference.name())
            } else {
                let source = reference.argument_expression();
                let value = self.expression(source)?;
                self.coerce(value, Type::Dyn, source)?
            };
            (
                self.dynamic_get(reference, receiver.clone(), key),
                Some(receiver),
            )
        } else {
            (self.expression(tag)?, None)
        };
        let callee = self.callable_body(callee, tag)?;
        let callee = self.coerce(callee, Type::Dyn, tag)?;
        let callee = self.update_temp(callee, &mut stmts, tag);
        let template = node.template();
        let (parts, spans) = if template.kind() == SyntaxKind::NoSubstitutionTemplateLiteral {
            (vec![template], vec![])
        } else if template.kind() == SyntaxKind::TemplateExpression {
            let spans = template.template_spans().nodes().to_vec();
            let mut parts = vec![template.head()];
            parts.extend(spans.iter().map(|span| span.literal()));
            (parts, spans)
        } else {
            return Err(self.refuse(node, "tagged template requires a template literal"));
        };
        let mut cooked = Vec::new();
        let mut raw = Vec::new();
        for part in parts {
            let value = if part
                .template_flags()
                .intersects(TokenFlags::CONTAINS_INVALID_ESCAPE)
            {
                return Err(self.refuse(part, "invalid tagged-template escapes require undefined-preserving typed array views"));
            } else {
                let bytes = source_frontend::scanner_util::go_string_bytes(part.text());
                let value = std::str::from_utf8(&bytes)
                    .map_err(|_| self.refuse(part, "lone UTF-16 surrogates are not ported"))?;
                self.string_literal(value, part)
            };
            cooked.push(self.coerce(value, Type::Dyn, part)?);
            let value = self.string_literal(&self.template_raw_part(part)?, part);
            raw.push(self.coerce(value, Type::Dyn, part)?);
        }
        let array_type = Type::Array {
            elem: Box::new(Type::Dyn),
        };
        let loc = self.loc(node);
        let site = format!("{}:{}:{}", loc.file, loc.start, loc.end);
        let array = |elems| Expr::ArrayLit {
            elems,
            r#type: array_type.clone(),
            loc: loc.clone(),
        };
        let object = Expr::LibCall {
            r#fn: "template.object".into(),
            args: vec![self.string_literal(&site, node), array(cooked), array(raw)],
            r#type: array_type.clone(),
            loc: loc.clone(),
        };
        let mut args = vec![self.coerce(object, Type::Dyn, node)?];
        for span in spans {
            let source = span.expression();
            args.push(self.expected_expression(source, Type::Dyn)?);
        }
        let result = if let Some(receiver) = receiver {
            Expr::LibCall {
                r#fn: "dyn.callWithThisSpread".into(),
                args: vec![callee, receiver, array(args)],
                r#type: Type::Dyn,
                loc: loc.clone(),
            }
        } else {
            Expr::DynCall {
                callee: Box::new(callee),
                callee_name: "tagged template".into(),
                args,
                r#type: Type::Dyn,
                loc: loc.clone(),
            }
        };
        Ok(Expr::Sequence {
            stmts,
            result: Box::new(result),
            r#type: Type::Dyn,
            loc,
        })
    }

    pub(super) fn string_raw_template(&mut self, node: Node) -> Result<Option<Expr>, String> {
        let tag = node.tag();
        if tag.kind() != SyntaxKind::PropertyAccessExpression
            || tag.name().text() != "raw"
            || tag.expression().kind() != SyntaxKind::Identifier
        {
            return Ok(None);
        }
        let receiver_symbol = self.symbol(tag.expression());
        let member_symbol = self.symbol(tag.name());
        if !self.primitive_symbol(receiver_symbol, "String", None)
            || !self.primitive_symbol(member_symbol, "raw", Some("StringConstructor"))
        {
            return Ok(None);
        }
        let template = node.template();
        if template.kind() == SyntaxKind::NoSubstitutionTemplateLiteral {
            let raw = self.template_raw_part(template)?;
            return Ok(Some(self.string_literal(&raw, node)));
        }
        if template.kind() != SyntaxKind::TemplateExpression {
            return Err(self.refuse(node, "String.raw requires a template literal"));
        }
        // A tagged template is a call: every substitution expression runs
        // before String.raw starts converting any of the argument values.
        let mut stmts = Vec::new();
        let mut substitutions = Vec::new();
        for span in template.template_spans().nodes() {
            let source = span.expression();
            let value = self.expression(source)?;
            let value = self.update_temp(value, &mut stmts, source);
            substitutions.push((source, value, span.literal()));
        }
        let head = self.template_raw_part(template.head())?;
        let mut result = self.string_literal(&head, node);
        for (source, value, literal) in substitutions {
            let value = self.string_value(value, source, Context::Template)?;
            result = self.string_concat(result, value, node);
            let raw = self.template_raw_part(literal)?;
            result = self.string_concat(result, self.string_literal(&raw, node), node);
        }
        Ok(Some(Expr::Sequence {
            stmts,
            result: Box::new(result),
            r#type: Type::String,
            loc: self.loc(node),
        }))
    }

    pub(super) fn string_value(
        &mut self,
        value: Expr,
        node: Node,
        context: Context,
    ) -> Result<Expr, String> {
        let value = self
            .raw_record_field(&value, node)
            .or_else(|| self.raw_array_element(&value, node))
            .or_else(|| self.raw_primitive_projection(&value))
            .unwrap_or(value);
        let ty = value.ty();
        match ty {
            Type::String => Ok(value),
            Type::Bigint => Ok(self.bigint_operation("bigint.toString", vec![value], node)),
            Type::F64 | Type::Bool => Ok(Expr::ToString {
                operand: Box::new(value),
                r#type: Type::String,
                loc: self.loc(node),
            }),
            Type::Array { .. } => self.join_value(value, self.string_literal(",", node), node),
            Type::Record { shape_id } if self.records[shape_id].tuple => {
                self.join_value(value, self.string_literal(",", node), node)
            }
            Type::Null | Type::Undefined => {
                let value = self.coerce(value, Type::Dyn, node)?;
                self.string_value(value, node, context)
            }
            Type::Union { union_id } => {
                let mut helper = Helper::new(
                    match context {
                        Context::Template => "string_union",
                        Context::Element => "join_union",
                        Context::Separator => "separator_union",
                    },
                    vec![ty],
                    Type::String,
                    self.loc(node),
                );
                let slot = helper.param(0);
                for (tag, arm) in self.unions[union_id].arms.clone().into_iter().enumerate() {
                    let result = if matches!(arm, Type::Null | Type::Undefined) {
                        self.string_literal(
                            match (context, arm) {
                                (Context::Element, _) => "",
                                (Context::Separator, Type::Undefined) => ",",
                                (_, Type::Null) => "null",
                                _ => "undefined",
                            },
                            node,
                        )
                    } else {
                        let operand = Expr::UnionNarrow {
                            union_id: format!("u{union_id}"),
                            tag,
                            value: Box::new(helper.read(&slot)),
                            r#type: arm,
                            loc: helper.loc(),
                        };
                        self.string_value(operand, node, context)?
                    };
                    helper.function.body.push(Stmt::If {
                        cond: Expr::UnionIsTag {
                            union_id: format!("u{union_id}"),
                            tag,
                            negated: false,
                            value: Box::new(helper.read(&slot)),
                            r#type: Type::Bool,
                            loc: helper.loc(),
                        },
                        then: vec![Stmt::Return {
                            value: Some(result),
                            loc: helper.loc(),
                        }],
                        else_: None,
                        loc: helper.loc(),
                    });
                }
                // Tags are exhaustively checked above; the IR still requires a
                // syntactic return for a non-void helper.
                helper.function.body.push(Stmt::Return {
                    value: Some(self.string_literal("", node)),
                    loc: helper.loc(),
                });
                let callee = self.install_helper(helper.function);
                Ok(Expr::Call {
                    callee,
                    args: vec![value],
                    r#type: Type::String,
                    loc: self.loc(node),
                })
            }
            Type::Dyn => {
                if matches!(context, Context::Template) {
                    return Ok(Expr::ToString {
                        operand: Box::new(value),
                        r#type: Type::String,
                        loc: self.loc(node),
                    });
                }
                let mut helper = Helper::new(
                    match context {
                        Context::Element => "join_dynamic",
                        _ => "separator_dynamic",
                    },
                    vec![Type::Dyn],
                    Type::String,
                    self.loc(node),
                );
                let slot = helper.param(0);
                helper.function.body.push(Stmt::If {
                    cond: Expr::DynTest {
                        value: Box::new(helper.read(&slot)),
                        test: if matches!(context, Context::Element) {
                            "nullish"
                        } else {
                            "undefined"
                        }
                        .into(),
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Return {
                        value: Some(self.string_literal(
                            if matches!(context, Context::Element) {
                                ""
                            } else {
                                ","
                            },
                            node,
                        )),
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                });
                helper.function.body.push(Stmt::Return {
                    value: Some(Expr::ToString {
                        operand: Box::new(helper.read(&slot)),
                        r#type: Type::String,
                        loc: helper.loc(),
                    }),
                    loc: helper.loc(),
                });
                let callee = self.install_helper(helper.function);
                Ok(Expr::Call {
                    callee,
                    args: vec![value],
                    r#type: Type::String,
                    loc: self.loc(node),
                })
            }
            _ => Err(self.refuse(
                node,
                "object string conversion requires native ToPrimitive support",
            )),
        }
    }

    pub(super) fn array_join(&mut self, node: Node) -> Result<Expr, String> {
        let receiver_node = node.expression().expression();
        let receiver = self.expression(receiver_node)?;
        let receiver = self.live_member_receiver(receiver_node, receiver);
        let receiver = self.checked_array_value(receiver_node, receiver, false)?;
        self.array_join_value(node, receiver)
    }

    pub(super) fn array_join_value(&mut self, node: Node, receiver: Expr) -> Result<Expr, String> {
        let receiver = self.join_receiver(receiver, node)?;
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 1
            || arguments
                .iter()
                .any(|n| n.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "array.join accepts at most one non-spread separator"));
        }
        let separator = if let Some(arg) = arguments.first() {
            self.expression(*arg)?
        } else {
            self.string_literal(",", node)
        };
        let separator = self.string_value(separator, node, Context::Separator)?;
        self.join_value(receiver, separator, node)
    }

    /// Resolve the method receiver before evaluating the separator. A missing
    /// receiver must throw at property access, even if the argument has effects.
    fn join_receiver(&mut self, receiver: Expr, node: Node) -> Result<Expr, String> {
        let Type::Union { union_id } = receiver.ty() else {
            return Ok(receiver);
        };
        let Some(elem) = self.nullable_array_element(&receiver.ty()) else {
            return Ok(receiver);
        };
        let array = Type::Array {
            elem: Box::new(elem),
        };
        let arms = self.unions[union_id].arms.clone();
        let mut helper = Helper::new(
            "array_join_receiver",
            vec![receiver.ty()],
            array.clone(),
            self.loc(node),
        );
        let input = helper.param(0);
        for (tag, arm) in arms.iter().enumerate() {
            let value = if *arm == array {
                Expr::UnionNarrow {
                    value: Box::new(helper.read(&input)),
                    union_id: format!("u{union_id}"),
                    tag,
                    r#type: array.clone(),
                    loc: helper.loc(),
                }
            } else {
                let unit = Expr::UnitLit {
                    unit: if *arm == Type::Null {
                        "null"
                    } else {
                        "undefined"
                    },
                    r#type: arm.clone(),
                    loc: helper.loc(),
                };
                let unit = self.coerce(unit, Type::Dyn, node)?;
                let key = self.string_literal("join", node);
                let access = self.dynamic_get(node, unit, key);
                self.coerce(access, array.clone(), node)?
            };
            let ret = Stmt::Return {
                value: Some(value),
                loc: helper.loc(),
            };
            if tag + 1 == arms.len() {
                helper.function.body.push(ret);
            } else {
                helper.function.body.push(Stmt::If {
                    cond: Expr::UnionIsTag {
                        value: Box::new(helper.read(&input)),
                        union_id: format!("u{union_id}"),
                        tag,
                        negated: false,
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![ret],
                    else_: None,
                    loc: helper.loc(),
                });
            }
        }
        let callee = self.install_helper(helper.function);
        Ok(Expr::Call {
            callee,
            args: vec![receiver],
            r#type: array,
            loc: self.loc(node),
        })
    }

    fn join_value(&mut self, receiver: Expr, separator: Expr, node: Node) -> Result<Expr, String> {
        if !matches!(receiver.ty(), Type::Array { .. })
            && !matches!(receiver.ty(), Type::Record { shape_id } if self.records[shape_id].tuple)
        {
            return Err(self.refuse(
                node,
                "array.join requires a represented array or fixed tuple receiver",
            ));
        }
        if let Type::Record { shape_id } = receiver.ty() {
            let mut helper = Helper::new(
                "tuple_join",
                vec![receiver.ty(), Type::String],
                Type::String,
                self.loc(node),
            );
            let tuple = helper.param(0);
            let separator_slot = helper.param(1);
            let text = helper.local("text", Type::String, true);
            helper.declare(&text, self.string_literal("", node));
            for index in 0..self.records[shape_id].fields.len() {
                // Layout fields are sorted lexically; tuple iteration follows
                // numeric positions, including positions greater than nine.
                let name = index.to_string();
                let field = self.records[shape_id]
                    .fields
                    .iter()
                    .find(|f| f.name == name)
                    .expect("required tuple position")
                    .clone();
                if index != 0 {
                    helper.function.body.push(Stmt::Assign {
                        local_id: text.id.clone(),
                        value: self.string_concat(
                            helper.read(&text),
                            helper.read(&separator_slot),
                            node,
                        ),
                        initializes_global: false,
                        loc: helper.loc(),
                    });
                }
                let item = Expr::RecordGet {
                    obj: Box::new(helper.read(&tuple)),
                    shape_id: format!("r{shape_id}"),
                    field: field.name,
                    r#type: field.r#type,
                    loc: helper.loc(),
                };
                let item = self.string_value(item, node, Context::Element)?;
                helper.function.body.push(Stmt::Assign {
                    local_id: text.id.clone(),
                    value: self.string_concat(helper.read(&text), item, node),
                    initializes_global: false,
                    loc: helper.loc(),
                });
            }
            let callee = self.install_helper(helper.finish(&text));
            return Ok(Expr::Call {
                callee,
                args: vec![receiver, separator],
                r#type: Type::String,
                loc: self.loc(node),
            });
        }
        let Type::Array { elem } = receiver.ty() else {
            unreachable!()
        };
        if *elem == Type::String {
            // The shared string-array join reads sparse slot states. A typed
            // arrayGet would try to extract holes as strings and throw.
            return Ok(Expr::ArrayIntrinsic {
                method: "join".into(),
                receiver: Box::new(receiver),
                args: vec![separator],
                r#type: Type::String,
                loc: self.loc(node),
            });
        }
        let mut helper = Helper::new(
            "array_join",
            vec![receiver.ty(), Type::String],
            Type::String,
            self.loc(node),
        );
        let array = helper.param(0);
        let separator_slot = helper.param(1);
        let length = helper.local("length", Type::F64, false);
        let index = helper.local("index", Type::F64, true);
        let text = helper.local("text", Type::String, true);
        helper.declare(&length, helper.length(&array));
        helper.declare(&index, helper.number(0.0));
        helper.declare(&text, self.string_literal("", node));
        let item = if *elem == Type::Dyn {
            // Dynamic indexed reads map both holes and explicit undefined to
            // undefined, which contributes an empty field to Array.join.
            let receiver = self.coerce(helper.read(&array), Type::Dyn, node)?;
            let key = self.string_value(helper.read(&index), node, Context::Template)?;
            self.dynamic_get(node, receiver, key)
        } else {
            helper.get(&array, &index, *elem)
        };
        let item = self.string_value(item, node, Context::Element)?;
        helper.function.body.push(Stmt::While {
            cond: helper.less(&index, helper.read(&length)),
            body: vec![
                Stmt::If {
                    cond: Expr::Bin {
                        op: ">".into(),
                        left: Box::new(helper.read(&index)),
                        right: Box::new(helper.number(0.0)),
                        r#type: Type::Bool,
                        loc: helper.loc(),
                    },
                    then: vec![Stmt::Assign {
                        local_id: text.id.clone(),
                        value: self.string_concat(
                            helper.read(&text),
                            helper.read(&separator_slot),
                            node,
                        ),
                        initializes_global: false,
                        loc: helper.loc(),
                    }],
                    else_: None,
                    loc: helper.loc(),
                },
                Stmt::Assign {
                    local_id: text.id.clone(),
                    value: self.string_concat(helper.read(&text), item, node),
                    initializes_global: false,
                    loc: helper.loc(),
                },
                helper.advance(&index),
            ],
            loc: helper.loc(),
        });
        let callee = self.install_helper(helper.finish(&text));
        Ok(Expr::Call {
            callee,
            args: vec![receiver, separator],
            r#type: Type::String,
            loc: self.loc(node),
        })
    }
}
