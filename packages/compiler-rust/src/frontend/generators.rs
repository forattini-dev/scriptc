//! Typed synchronous/async generator channels.
use super::*;

impl Lowerer<'_> {
    pub(super) fn iterator_generator_type(&mut self, id: TypeId) -> Option<Type> {
        if !self.standard_iterator_type(id) {
            return None;
        }
        let symbol = self.checker.ty(id).symbol();
        let iterable_only = symbol.0 != 0 && self.checker.sym(symbol).name.as_ref() == "Iterable";
        let arguments = self.checker.get_type_arguments(id).to_vec();
        let yielded = *arguments.first()?;
        let channel = |lowerer: &mut Lowerer<'_>, source: TypeId, unit: Type| {
            let flags = lowerer.checker.ty(source).flags;
            if flags.intersects(TypeFlags::VOID | TypeFlags::NEVER | TypeFlags::UNDEFINED) {
                Some(unit)
            } else {
                lowerer.type_id(source)
            }
        };
        Some(Type::Generator {
            r#async: false,
            yield_type: Box::new(channel(self, yielded, Type::Void)?),
            // A plain Iterable exposes only values consumed by for-of; its
            // iterator's terminal return payload is not part of that contract.
            // Keep the channel unit-valued even when newer lib.d.ts revisions
            // materialize a default `any` TReturn argument.
            return_type: Box::new(if iterable_only {
                Type::Void
            } else {
                match arguments.get(1).copied() {
                    Some(source) => channel(self, source, Type::Void)?,
                    None => Type::Void,
                }
            }),
            next_type: Box::new(match arguments.get(2).copied() {
                Some(source) => channel(self, source, Type::Dyn)?,
                None => Type::Dyn,
            }),
        })
    }

    pub(super) fn synchronous_generator_argument(&self, ty: Type) -> Option<Type> {
        match ty {
            ty @ Type::Generator { r#async: false, .. } => Some(ty),
            Type::Union { union_id }
                if self.unions[union_id].arms.iter().all(|arm| {
                    matches!(arm, Type::Generator { .. } | Type::Null | Type::Undefined)
                }) =>
            {
                let mut synchronous = self.unions[union_id]
                    .arms
                    .iter()
                    .filter(|arm| matches!(arm, Type::Generator { r#async: false, .. }));
                let selected = synchronous.next()?.clone();
                synchronous.next().is_none().then_some(selected)
            }
            _ => None,
        }
    }

    pub(super) fn synchronous_iterable_argument(
        &self,
        actual: Type,
        expected: &Type,
    ) -> Option<Type> {
        let expected = match expected {
            expected @ Type::Generator { r#async: false, .. } => expected,
            Type::Union { union_id } => {
                let mut synchronous = self.unions[*union_id]
                    .arms
                    .iter()
                    .filter(|arm| matches!(arm, Type::Generator { r#async: false, .. }));
                let expected = synchronous.next()?;
                if synchronous.next().is_some() {
                    return None;
                }
                expected
            }
            _ => return None,
        };
        let Type::Generator { yield_type, .. } = expected else {
            unreachable!()
        };
        match &actual {
            Type::Array { elem } | Type::Set { elem } if **elem == **yield_type => Some(actual),
            Type::String if **yield_type == Type::String => Some(actual),
            _ => self.synchronous_generator_argument(actual),
        }
    }

    pub(super) fn standard_iterator_type(&self, id: TypeId) -> bool {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return false;
        }
        let symbol = self.checker.sym(symbol);
        matches!(
            symbol.name.as_ref(),
            "Iterable" | "Iterator" | "IterableIterator"
        ) && symbol.declarations.iter().any(|node| {
            source_frontend::frontend::bundled::bundled_lib_name(
                &source_file_info(source_frontend::prelude::get_source_file_of_node(*node))
                    .file_name,
            )
            .is_some()
        })
    }

    pub(super) fn generator_call(&mut self, node: Node) -> Result<Option<Expr>, String> {
        if node.kind() != SyntaxKind::CallExpression {
            return Ok(None);
        }
        let member = node.expression();
        if member.kind() == SyntaxKind::ElementAccessExpression {
            let key = primitives::primitive_source(member.argument_expression());
            if key.kind() != SyntaxKind::PropertyAccessExpression
                || key.name().text() != "asyncIterator"
                || !self.standard_symbol(key.expression())
            {
                return Ok(None);
            }
            if !node.arguments().is_empty() {
                return Err(self.refuse(
                    node,
                    "Symbol.asyncIterator on a generator accepts no arguments",
                ));
            }
            let target = self.ty(node)?;
            let iterator = self.expression(member.expression())?;
            if matches!(iterator.ty(), Type::Generator { r#async: true, .. }) {
                // AsyncGenerator.prototype[Symbol.asyncIterator]() is the
                // identity operation. Keep the exact stateful handle.
                return Ok(Some(self.coerce(iterator, target, node)?));
            }
            // User-defined async iterables (including object literals emitted
            // by Octokit) keep their symbol-keyed method in the dynamic native
            // descriptor. The runtime invokes it with the receiver as `this`.
            let iterator = self.coerce(iterator, Type::Dyn, member.expression())?;
            let value = Expr::LibCall {
                r#fn: "dyn.asyncIterator".into(),
                args: vec![iterator],
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            return Ok(Some(self.coerce(value, target, node)?));
        }
        if member.kind() != SyntaxKind::PropertyAccessExpression {
            return Ok(None);
        }
        let operation = member.name().text();
        if !matches!(operation.as_ref(), "next" | "return") {
            return Ok(None);
        }
        // Do not lower an arbitrary `.next()` receiver before proving that its
        // checker type is one of the represented generator handles. Besides
        // avoiding spurious work, this preserves the normal method pipeline
        // for user-defined iterator-like objects.
        let source_receiver = receivers::reference_node(member.expression());
        let stored_receiver = (source_receiver.kind() == SyntaxKind::Identifier)
            .then(|| {
                let symbol = self.symbol(source_receiver);
                self.bindings
                    .get(&symbol)
                    .or_else(|| self.module_bindings.get(&symbol))
                    .or_else(|| self.outer.iter().rev().find_map(|scope| scope.get(&symbol)))
                    .map(|local| local.r#type.clone())
                    .or_else(|| self.var_types.get(&symbol).cloned())
            })
            .flatten();
        let erased_receiver = stored_receiver == Some(Type::Dyn);
        let checker_receiver = self.ty(member.expression());
        if !erased_receiver && !matches!(checker_receiver, Ok(Type::Generator { .. })) {
            return Ok(None);
        }
        let generator = self.expression(member.expression())?;
        if generator.ty() == Type::Dyn {
            // Protocol calls such as `value?.[Symbol.iterator]?.()` own an
            // erased native iterator even when JSDoc/checker declarations
            // expose the binding as Generator. Keep `.next()`/`.return()` on
            // the dynamic receiver ABI instead of projecting it into a
            // compiled generator handle.
            let arguments = node.arguments().into_iter().collect::<Vec<_>>();
            if arguments.len() > 1
                || arguments
                    .iter()
                    .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
            {
                return Err(
                    self.refuse(node, "generator resume accepts at most one ordinary value")
                );
            }
            let args = arguments
                .into_iter()
                .map(|argument| self.expected_expression(argument, Type::Dyn))
                .collect::<Result<Vec<_>, _>>()?;
            let result = Expr::DynInvoke {
                recv: Box::new(generator),
                method: operation.into(),
                callee_name: operation.into(),
                optional: false,
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            let target = self.ty(node)?;
            return Ok(Some(self.coerce(result, target, node)?));
        }
        let Type::Generator {
            r#async,
            return_type,
            next_type,
            ..
        } = generator.ty()
        else {
            return Ok(None);
        };
        let erased_array_owner = if !r#async && erased_receiver {
            match &generator {
                Expr::DynCheck { value, .. } if matches!(value.as_ref(), Expr::VarRef { .. }) => {
                    Some(value.as_ref().clone())
                }
                _ => None,
            }
        } else {
            None
        };
        let arguments = node.arguments().into_iter().collect::<Vec<_>>();
        if arguments.len() > 1
            || arguments
                .iter()
                .any(|argument| argument.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(node, "generator resume accepts at most one ordinary value"));
        }
        let value = if let Some(argument) = arguments.first().copied() {
            let channel = if operation == "next" {
                (*next_type).clone()
            } else {
                (*return_type).clone()
            };
            if operation == "return"
                && matches!(channel, Type::Void | Type::Undefined)
                && !matches!(self.ty(argument), Ok(Type::Void | Type::Undefined))
            {
                return Err(self.refuse(argument, "generator return value cannot be represented by an undefined-only return channel"));
            }
            if matches!(channel, Type::Void | Type::Undefined)
                && matches!(self.ty(argument), Ok(Type::Void | Type::Undefined))
            {
                Some(self.expression(argument)?)
            } else {
                Some(self.expected_expression(argument, channel)?)
            }
        } else if operation == "next" {
            let missing = Expr::UnitLit {
                unit: "undefined",
                r#type: Type::Undefined,
                loc: self.loc(node),
            };
            Some(self.coerce(missing, (*next_type).clone(), node)?)
        } else {
            None
        };
        let result_type = if r#async {
            Type::Promise {
                inner: Box::new(Type::Dyn),
            }
        } else {
            Type::Dyn
        };
        let result = if operation == "next" {
            Expr::GeneratorNext {
                generator: Box::new(generator),
                value: Box::new(value.expect("generator next input")),
                r#type: result_type,
                loc: self.loc(node),
            }
        } else {
            Expr::GeneratorReturn {
                generator: Box::new(generator),
                value: value.map(Box::new),
                r#type: result_type,
                loc: self.loc(node),
            }
        };
        let result = if let Some(owner) = erased_array_owner {
            // An Array is Iterable but is not itself an Iterator. An explicit
            // `.next()` must perform the real property lookup instead of
            // adapting the Array to a generator as a for-of loop would.
            let args = arguments
                .iter()
                .copied()
                .map(|argument| self.expected_expression(argument, Type::Dyn))
                .collect::<Result<Vec<_>, _>>()?;
            let call = Expr::DynInvoke {
                recv: Box::new(owner.clone()),
                method: operation.into(),
                callee_name: format!("{}.{}", source_receiver.text(), operation),
                optional: false,
                args,
                r#type: Type::Dyn,
                loc: self.loc(node),
            };
            Expr::Ternary {
                cond: Box::new(Expr::DynTest {
                    value: Box::new(owner),
                    test: "array".into(),
                    negated: false,
                    r#type: Type::Bool,
                    loc: self.loc(node),
                }),
                then: Box::new(call),
                else_: Box::new(result),
                r#type: Type::Dyn,
                loc: self.loc(node),
            }
        } else {
            result
        };
        let target = self.ty(node)?;
        Ok(Some(self.coerce(result, target, node)?))
    }

    pub(super) fn generator_type(&mut self, id: TypeId) -> Option<Type> {
        let symbol = self.checker.ty(id).symbol();
        if symbol.0 == 0 {
            return None;
        }
        let symbol = self.checker.sym(symbol);
        let asynchronous = match symbol.name.as_ref() {
            "Generator" => false,
            "AsyncGenerator" => true,
            _ => return None,
        };
        if !symbol.declarations.iter().any(|node| {
            let info = source_file_info(source_frontend::prelude::get_source_file_of_node(*node));
            let path = &info.file_name;
            path.ends_with("/lib.es2015.generator.d.ts")
                || path.ends_with("/lib.es2018.asyncgenerator.d.ts")
        }) {
            return None;
        }
        let args = self.checker.get_type_arguments(id).to_vec();
        if args.len() != 3 {
            return None;
        }
        let channel = |lowerer: &mut Lowerer<'_>, source: TypeId, unit: Type| {
            let flags = lowerer.checker.ty(source).flags;
            if flags.intersects(TypeFlags::VOID | TypeFlags::NEVER | TypeFlags::UNDEFINED) {
                Some(unit)
            } else {
                lowerer.type_id(source)
            }
        };
        Some(Type::Generator {
            r#async: asynchronous,
            yield_type: Box::new(channel(self, args[0], Type::Void)?),
            return_type: Box::new(channel(self, args[1], Type::Void)?),
            next_type: Box::new(channel(self, args[2], Type::Undefined)?),
        })
    }
}
