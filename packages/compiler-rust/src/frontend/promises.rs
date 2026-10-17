//! Standard Promise identities and synchronous factories; reactions stay queued.
use super::*;
use source_frontend::prelude::{SignatureKind, SymbolId, get_source_file_of_node};

impl Lowerer<'_> {
    pub(super) fn promise_type(&mut self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0
            || self.checker.sym(symbol).name.as_ref() != "Promise"
            || !self.standard_promise(symbol)
        {
            return None;
        }
        let args = self.checker.get_type_arguments(id).to_vec();
        if args.len() != 1 {
            return None;
        }
        let flags = self.checker.ty(args[0]).flags;
        let inner = if flags.intersects(TypeFlags::VOID | TypeFlags::NEVER | TypeFlags::UNDEFINED) {
            Type::Void
        } else if flags.intersects(TypeFlags::NULL) {
            // Unit payloads have native tags, without a bare-unit callable ABI.
            Type::Dyn
        } else {
            self.type_id(args[0])?
        };
        Some(Type::Promise {
            inner: Box::new(inner),
        })
    }
    fn native_thenable(&self, ty: &Type) -> bool {
        match ty {
            Type::Func { .. } | Type::Dyn => true,
            Type::Record { shape_id } => self.callables.contains_key(shape_id),
            Type::Union { union_id } => self.unions[*union_id]
                .arms
                .iter()
                .any(|a| self.native_thenable(a)),
            _ => false,
        }
    }
    fn refuse_thenable(&self, ty: &Type, node: Node) -> Result<(), String> {
        if let Type::Record { shape_id } = ty
            && self.records[*shape_id]
                .fields
                .iter()
                .any(|f| f.name == "then" && self.native_thenable(&f.r#type))
        {
            return Err(self.refuse(node, "native thenable assimilation is not ported"));
        }
        Ok(())
    }
    fn standard_promise(&self, symbol: SymbolId) -> bool {
        self.checker.sym(symbol).declarations.iter().any(|n| {
            if n.is_nil() {
                return false;
            }
            let info = source_file_info(get_source_file_of_node(*n));
            let path = &info.file_name;
            path.ends_with("/lib.es5.d.ts") || path.ends_with("/lib.es2015.promise.d.ts")
        })
    }
    pub(super) fn promise_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        self.promise_call_expected(node, None)
    }
    pub(super) fn promise_call_expected(
        &mut self,
        node: Node,
        expected: Option<Type>,
    ) -> Result<Option<Expr>, String> {
        let member = node.expression();
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let receiver = member.expression();
        let symbol = self.symbol(receiver);
        if symbol != 0
            && self.checker.sym(SymbolId(symbol)).name.as_ref() == "Promise"
            && self.standard_promise(SymbolId(symbol))
        {
            if member.name().text() != "resolve" {
                return Err(self.refuse(node, "Promise static method is not ported"));
            }
            let args = node.arguments().into_iter().collect::<Vec<_>>();
            if args.len() > 1 {
                return Err(self.refuse(node, "Promise.resolve extra arguments are not ported"));
            }
            let contextual = expected.is_some();
            let result = match expected {
                Some(ty) => ty,
                None => self.ty(node)?,
            };
            if !matches!(result, Type::Promise { .. }) {
                return Err(self.refuse(node, "Promise.resolve needs a native Promise contract"));
            }
            let Type::Promise { inner: payload } = &result else {
                unreachable!()
            };
            let mut values = args
                .into_iter()
                .map(|arg| {
                    let source = self.ty(arg)?;
                    self.refuse_thenable(&source, arg)?;
                    if contextual
                        && **payload != Type::Void
                        && !matches!(source, Type::Promise { .. } | Type::Null | Type::Undefined)
                    {
                        self.expected_expression(arg, (**payload).clone())
                    } else {
                        self.expression(arg)
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            if values
                .first()
                .is_some_and(|value| matches!(value.ty(), Type::Promise { .. }))
            {
                return self.coerce(values.remove(0), result, node).map(Some);
            }
            if values
                .first()
                .is_some_and(|value| matches!(value.ty(), Type::Null | Type::Undefined))
            {
                let value = values.remove(0);
                values.push(self.coerce(value, Type::Dyn, node)?);
            }
            if let Some(value) = values.first() {
                self.refuse_thenable(&value.ty(), node)?;
            }
            let inner = values.first().map(Expr::ty).unwrap_or(Type::Void);
            let ty = Type::Promise {
                inner: Box::new(inner),
            };
            let value = Expr::Intrinsic {
                name: "promise.resolve".into(),
                args: values,
                r#type: ty,
                loc: self.loc(node),
            };
            return self.coerce(value, result, node).map(Some);
        }
        if !matches!(self.ty(receiver), Ok(Type::Promise { .. })) {
            return Ok(None);
        }
        if member.name().text() != "then" {
            return Err(self.refuse(node, "Promise method is not ported"));
        }
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.len() > 1 {
            return Err(self.refuse(node, "Promise rejection callbacks are not ported"));
        }
        let recv = self.expression(receiver)?;
        let recv = self.coerce(recv, Type::Dyn, receiver)?;
        let mut values = Vec::new();
        for arg in args {
            // A Promise<void> callback still receives the JavaScript undefined value.
            if matches!(
                arg.kind(),
                SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
            ) {
                let id = self.checker.get_type_at_location(arg);
                let signatures = self.checker.get_signatures_of_type(id, SignatureKind::CALL);
                if signatures.len() != 1 {
                    return Err(self.refuse(arg, "Promise reaction signature is not ported"));
                }
                let ret = self.checker.get_return_type_of_signature(signatures[0]);
                let ret = if self.checker.ty(ret).flags.intersects(TypeFlags::VOID) {
                    Type::Void
                } else {
                    let ty = self.type_id(ret).ok_or_else(|| {
                        self.refuse(arg, "Promise reaction result has no native representation")
                    })?;
                    if matches!(ty, Type::Null | Type::Undefined) {
                        Type::Dyn
                    } else {
                        ty
                    }
                };
                self.refuse_thenable(&ret, arg)?;
                let Type::Promise { inner } = self.ty(receiver)? else {
                    unreachable!()
                };
                let param = if matches!(*inner, Type::Void | Type::Null | Type::Undefined) {
                    Type::Dyn
                } else {
                    *inner
                };
                let callback = self.closure(
                    arg,
                    Some(Type::Func {
                        params: vec![param],
                        ret: Box::new(ret),
                    }),
                )?;
                values.push(self.coerce(callback, Type::Dyn, arg)?);
            } else {
                values.push(self.expected_expression(arg, Type::Dyn)?);
            }
        }
        let value = Expr::DynInvoke {
            recv: Box::new(recv),
            method: "then".into(),
            callee_name: "Promise.then".into(),
            args: values,
            r#type: Type::Dyn,
            loc: self.loc(node),
        };
        let target = self.ty(node)?;
        self.coerce(value, target, node).map(Some)
    }
}
