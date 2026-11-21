//! Bounded proofs for a conditional result derived from an immutable value.
use super::*;
use source_frontend::prelude::SymbolId;

impl Lowerer<'_> {
    /// Prove a filtered discriminant implies an initialized data field when
    /// every element of the local array is a fresh, statically known literal.
    /// The source cannot escape or be mutated except through validated pushes.
    pub(super) fn filtered_literal_field_value(
        &mut self,
        node: Node,
        value: &Expr,
        target: &Type,
    ) -> Option<Expr> {
        if node.kind() != SyntaxKind::NonNullExpression {
            return None;
        }
        let Type::Union { union_id } = value.ty() else {
            return None;
        };
        if *target != Type::String
            || !self.unions[union_id]
                .arms
                .iter()
                .all(|arm| matches!(arm, Type::String | Type::Null | Type::Undefined))
        {
            return None;
        }
        let tag = self.unions[union_id]
            .arms
            .iter()
            .position(|arm| arm == target)?;
        let field = primitives::primitive_source(node.expression());
        if field.kind() != SyntaxKind::PropertyAccessExpression
            || !field.question_dot_token().is_nil()
            || field.expression().kind() != SyntaxKind::Identifier
        {
            return None;
        }
        let map_callback = node.parent();
        if map_callback.kind() != SyntaxKind::ArrowFunction
            || map_callback.body() != node
            || map_callback.parameters().len() != 1
            || map_callback.parameters().get(0).name().kind() != SyntaxKind::Identifier
            || self.symbol(map_callback.parameters().get(0).name()) == 0
            || self.symbol(field.expression())
                != self.symbol(map_callback.parameters().get(0).name())
        {
            return None;
        }
        let map_call = map_callback.parent();
        if map_call.kind() != SyntaxKind::CallExpression
            || map_call.arguments().len() != 1
            || map_call.arguments().get(0) != map_callback
            || !map_call.question_dot_token().is_nil()
        {
            return None;
        }
        let map = map_call.expression();
        if map.kind() != SyntaxKind::PropertyAccessExpression
            || map.name().text() != "map"
            || !map.question_dot_token().is_nil()
        {
            return None;
        }
        let mut filter_call = primitives::primitive_source(map.expression());
        if filter_call.kind() == SyntaxKind::CallExpression {
            let slice = filter_call.expression();
            if slice.kind() == SyntaxKind::PropertyAccessExpression
                && slice.name().text() == "slice"
                && slice.question_dot_token().is_nil()
                && filter_call.question_dot_token().is_nil()
                && filter_call.arguments().len() <= 2
                && filter_call
                    .arguments()
                    .iter()
                    .all(|arg| arg.kind() == SyntaxKind::NumericLiteral)
            {
                filter_call = primitives::primitive_source(slice.expression());
            }
        }
        if filter_call.kind() != SyntaxKind::CallExpression
            || filter_call.arguments().len() != 1
            || !filter_call.question_dot_token().is_nil()
        {
            return None;
        }
        let filter = filter_call.expression();
        if filter.kind() != SyntaxKind::PropertyAccessExpression
            || filter.name().text() != "filter"
            || !filter.question_dot_token().is_nil()
        {
            return None;
        }
        let source = primitives::primitive_source(filter.expression());
        if source.kind() != SyntaxKind::Identifier {
            return None;
        }
        let source_symbol = self.symbol(source);
        if source_symbol == 0 {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(source_symbol)).value_declaration;
        if declaration.is_nil()
            || declaration.kind() != SyntaxKind::VariableDeclaration
            || !declaration.parent().flags().contains(NodeFlags::CONST)
            || declaration.initializer().kind() != SyntaxKind::ArrayLiteralExpression
            || !declaration.initializer().elements().is_empty()
        {
            return None;
        }
        let predicate = filter_call.arguments().get(0);
        if predicate.kind() != SyntaxKind::ArrowFunction
            || predicate.parameters().len() != 1
            || predicate.parameters().get(0).name().kind() != SyntaxKind::Identifier
            || self.symbol(predicate.parameters().get(0).name()) == 0
        {
            return None;
        }
        let test = primitives::primitive_source(predicate.body());
        if test.kind() != SyntaxKind::BinaryExpression
            || test.operator_token().kind() != SyntaxKind::EqualsEqualsEqualsToken
        {
            return None;
        }
        let (key, discriminator) = [(test.left(), test.right()), (test.right(), test.left())]
            .into_iter()
            .find_map(|(property, literal)| {
                let property = primitives::primitive_source(property);
                let literal = primitives::primitive_source(literal);
                (property.kind() == SyntaxKind::PropertyAccessExpression
                    && property.question_dot_token().is_nil()
                    && property.expression().kind() == SyntaxKind::Identifier
                    && self.symbol(property.expression())
                        == self.symbol(predicate.parameters().get(0).name())
                    && literal.kind() == SyntaxKind::StringLiteral)
                    .then(|| {
                        (
                            property.name().text().to_string(),
                            literal.text().to_string(),
                        )
                    })
            })?;
        let field_name = field.name().text().to_string();
        if key == "__proto__" || field_name == "__proto__" {
            return None;
        }
        let mut scope = declaration.parent();
        while !scope.is_nil() && scope.kind() != SyntaxKind::Block {
            scope = scope.parent();
        }
        if scope.is_nil() || node.pos() < scope.pos() || node.end() > scope.end() {
            return None;
        }
        fn string_value(this: &mut Lowerer<'_>, node: Node) -> bool {
            fn no_assertions(node: Node) -> bool {
                if matches!(
                    node.kind(),
                    SyntaxKind::NonNullExpression
                        | SyntaxKind::AsExpression
                        | SyntaxKind::TypeAssertionExpression
                ) {
                    return false;
                }
                let mut valid = true;
                node.for_each_child(&mut |child| {
                    valid = valid && no_assertions(child);
                    !valid
                });
                valid
            }
            if !no_assertions(node) {
                return false;
            }
            let node = primitives::primitive_source(node);
            if matches!(
                node.kind(),
                SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
            ) {
                return true;
            }
            if node.kind() != SyntaxKind::CallExpression || !node.question_dot_token().is_nil() {
                return false;
            }
            let member = node.expression();
            if member.kind() != SyntaxKind::PropertyAccessExpression
                || !member.question_dot_token().is_nil()
                || !matches!(
                    member.name().text(),
                    "trim" | "trimStart" | "trimEnd" | "slice" | "substring"
                )
                || this.ty(member.expression()).ok() != Some(Type::String)
            {
                return false;
            }
            let symbol = this.symbol(member.name());
            this.primitive_symbol(symbol, member.name().text(), Some("String"))
        }
        fn valid_push(
            this: &mut Lowerer<'_>,
            call: Node,
            key: &str,
            discriminator: &str,
            field: &str,
        ) -> bool {
            if call.kind() != SyntaxKind::CallExpression
                || call.arguments().len() != 1
                || !call.question_dot_token().is_nil()
            {
                return false;
            }
            let object = call.arguments().get(0);
            if object.kind() != SyntaxKind::ObjectLiteralExpression {
                return false;
            }
            let properties = object.properties().into_iter().collect::<Vec<_>>();
            if properties.iter().any(|property| {
                property.kind() != SyntaxKind::PropertyAssignment
                    || property.name().kind() != SyntaxKind::Identifier
            }) {
                return false;
            }
            let keys = properties
                .iter()
                .filter(|property| property.name().text() == key)
                .collect::<Vec<_>>();
            if keys.len() != 1 {
                return false;
            }
            let kind = primitives::primitive_source(keys[0].initializer());
            if kind.kind() != SyntaxKind::StringLiteral {
                return false;
            }
            if kind.text() != discriminator {
                return true;
            }
            let fields = properties
                .iter()
                .filter(|property| property.name().text() == field)
                .collect::<Vec<_>>();
            fields.len() == 1 && string_value(this, fields[0].initializer())
        }
        fn read_only_pipeline(this: &mut Lowerer<'_>, member: Node) -> bool {
            let filter_call = member.parent();
            if filter_call.kind() != SyntaxKind::CallExpression
                || filter_call.expression() != member
                || !filter_call.question_dot_token().is_nil()
                || filter_call.arguments().len() != 1
            {
                return false;
            }
            let predicate = filter_call.arguments().get(0);
            if predicate.kind() != SyntaxKind::ArrowFunction
                || predicate.parameters().len() != 1
                || predicate.parameters().get(0).name().kind() != SyntaxKind::Identifier
            {
                return false;
            }
            let parameter = this.symbol(predicate.parameters().get(0).name());
            let condition = primitives::primitive_source(predicate.body());
            if parameter == 0
                || condition.kind() != SyntaxKind::BinaryExpression
                || condition.operator_token().kind() != SyntaxKind::EqualsEqualsEqualsToken
            {
                return false;
            }
            let pure_test = [
                (condition.left(), condition.right()),
                (condition.right(), condition.left()),
            ]
            .into_iter()
            .any(|(property, literal)| {
                let property = primitives::primitive_source(property);
                let literal = primitives::primitive_source(literal);
                property.kind() == SyntaxKind::PropertyAccessExpression
                    && property.question_dot_token().is_nil()
                    && property.expression().kind() == SyntaxKind::Identifier
                    && this.symbol(property.expression()) == parameter
                    && literal.kind() == SyntaxKind::StringLiteral
            });
            if !pure_test {
                return false;
            }
            let mut result = filter_call;
            let slice = result.parent();
            if slice.kind() == SyntaxKind::PropertyAccessExpression
                && slice.expression() == result
                && slice.name().text() == "slice"
                && slice.question_dot_token().is_nil()
            {
                let call = slice.parent();
                if call.kind() != SyntaxKind::CallExpression
                    || call.expression() != slice
                    || !call.question_dot_token().is_nil()
                    || call.arguments().len() > 2
                    || !call
                        .arguments()
                        .iter()
                        .all(|arg| arg.kind() == SyntaxKind::NumericLiteral)
                {
                    return false;
                }
                result = call;
            }
            let map = result.parent();
            if map.kind() != SyntaxKind::PropertyAccessExpression
                || map.expression() != result
                || map.name().text() != "map"
                || !map.question_dot_token().is_nil()
            {
                return false;
            }
            let call = map.parent();
            if call.kind() != SyntaxKind::CallExpression
                || call.expression() != map
                || !call.question_dot_token().is_nil()
                || call.arguments().len() != 1
            {
                return false;
            }
            let callback = call.arguments().get(0);
            if callback.kind() != SyntaxKind::ArrowFunction
                || callback.parameters().len() != 1
                || callback.parameters().get(0).name().kind() != SyntaxKind::Identifier
            {
                return false;
            }
            let parameter = this.symbol(callback.parameters().get(0).name());
            let body = primitives::primitive_source(callback.body());
            parameter != 0
                && body.kind() == SyntaxKind::PropertyAccessExpression
                && body.question_dot_token().is_nil()
                && body.name().text() != "__proto__"
                && body.expression().kind() == SyntaxKind::Identifier
                && this.symbol(body.expression()) == parameter
        }
        fn visit(
            this: &mut Lowerer<'_>,
            current: Node,
            declaration: Node,
            source: Node,
            symbol: u32,
            key: &str,
            discriminator: &str,
            field: &str,
        ) -> bool {
            if current.kind() == SyntaxKind::Identifier
                && this.symbol(current) == symbol
                && current != declaration.name()
                && current != source
            {
                let member = current.parent();
                if member.kind() != SyntaxKind::PropertyAccessExpression
                    || member.expression() != current
                    || !member.question_dot_token().is_nil()
                {
                    return false;
                }
                if member.name().text() == "push" {
                    if !valid_push(this, member.parent(), key, discriminator, field) {
                        return false;
                    }
                } else if member.name().text() == "filter" {
                    if !read_only_pipeline(this, member) {
                        return false;
                    }
                } else if member.name().text() != "length"
                    || member.parent().kind() != SyntaxKind::PropertyAssignment
                    || member.parent().initializer() != member
                {
                    return false;
                }
            }
            let mut valid = true;
            current.for_each_child(&mut |child| {
                valid = valid
                    && visit(
                        this,
                        child,
                        declaration,
                        source,
                        symbol,
                        key,
                        discriminator,
                        field,
                    );
                !valid
            });
            valid
        }
        if !visit(
            self,
            scope,
            declaration,
            source,
            source_symbol,
            &key,
            &discriminator,
            &field_name,
        ) {
            return None;
        }
        Some(Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag,
            value: Box::new(value.clone()),
            r#type: target.clone(),
            loc: self.loc(node),
        })
    }
    /// Prove the standard normalization idiom
    /// `if (record.items === undefined) return; Array.isArray(record.items)`.
    /// Native record fields are data slots rather than getters, and the
    /// immediately preceding terminal guard leaves the sole array arm active.
    /// Keeping this proof adjacency-bounded avoids trusting a stale checker
    /// narrowing across calls or arbitrary statements.
    pub(super) fn array_after_immediate_absence_exit(&mut self, node: Node, value: &Expr) -> bool {
        let Type::Union { union_id } = value.ty() else {
            return false;
        };
        let arms = &self.unions[union_id].arms;
        if arms
            .iter()
            .filter(|arm| matches!(arm, Type::Array { .. }))
            .count()
            != 1
            || !arms
                .iter()
                .all(|arm| matches!(arm, Type::Array { .. } | Type::Null | Type::Undefined))
            || !arms
                .iter()
                .any(|arm| matches!(arm, Type::Null | Type::Undefined))
        {
            return false;
        }
        let selected = primitives::primitive_source(node);
        if selected.kind() != SyntaxKind::PropertyAccessExpression
            || !selected.question_dot_token().is_nil()
        {
            return false;
        }
        let selected_receiver = primitives::primitive_source(selected.expression());
        if selected_receiver.kind() != SyntaxKind::Identifier {
            return false;
        }

        let mut statement = node;
        let block = loop {
            let parent = statement.parent();
            if parent.is_nil()
                || matches!(
                    parent.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::MethodDeclaration
                        | SyntaxKind::Constructor
                )
            {
                return false;
            }
            if parent.kind() == SyntaxKind::Block {
                break parent;
            }
            statement = parent;
        };
        let statements = block.statements().into_iter().collect::<Vec<_>>();
        let Some(previous) = statements
            .iter()
            .position(|candidate| *candidate == statement)
            .and_then(|index| index.checked_sub(1))
            .map(|index| statements[index])
        else {
            return false;
        };
        if previous.kind() != SyntaxKind::IfStatement || !previous.else_statement().is_nil() {
            return false;
        }
        let exit = previous.then_statement();
        let terminal = matches!(
            exit.kind(),
            SyntaxKind::ReturnStatement | SyntaxKind::ThrowStatement
        ) || (exit.kind() == SyntaxKind::Block
            && exit.statements().len() == 1
            && matches!(
                exit.statements().get(0).kind(),
                SyntaxKind::ReturnStatement | SyntaxKind::ThrowStatement
            ));
        if !terminal {
            return false;
        }
        fn pure_data_guard(node: Node) -> bool {
            let node = primitives::primitive_source(node);
            match node.kind() {
                SyntaxKind::Identifier
                | SyntaxKind::StringLiteral
                | SyntaxKind::NumericLiteral
                | SyntaxKind::TrueKeyword
                | SyntaxKind::FalseKeyword
                | SyntaxKind::NullKeyword => true,
                SyntaxKind::PropertyAccessExpression => {
                    node.question_dot_token().is_nil() && pure_data_guard(node.expression())
                }
                SyntaxKind::PrefixUnaryExpression => pure_data_guard(node.operand()),
                SyntaxKind::BinaryExpression => {
                    matches!(
                        node.operator_token().kind(),
                        SyntaxKind::BarBarToken
                            | SyntaxKind::AmpersandAmpersandToken
                            | SyntaxKind::EqualsEqualsToken
                            | SyntaxKind::EqualsEqualsEqualsToken
                            | SyntaxKind::ExclamationEqualsToken
                            | SyntaxKind::ExclamationEqualsEqualsToken
                    ) && pure_data_guard(node.left())
                        && pure_data_guard(node.right())
                }
                _ => false,
            }
        }
        fn same_absence_test(
            this: &mut Lowerer<'_>,
            node: Node,
            selected: Node,
            selected_receiver: Node,
        ) -> bool {
            let node = primitives::primitive_source(node);
            if node.kind() != SyntaxKind::BinaryExpression
                || !matches!(
                    node.operator_token().kind(),
                    SyntaxKind::EqualsEqualsToken | SyntaxKind::EqualsEqualsEqualsToken
                )
            {
                return false;
            }
            [(node.left(), node.right()), (node.right(), node.left())]
                .into_iter()
                .any(|(candidate, absent)| {
                    let candidate = primitives::primitive_source(candidate);
                    let absent = primitives::primitive_source(absent);
                    if candidate.kind() != SyntaxKind::PropertyAccessExpression
                        || !candidate.question_dot_token().is_nil()
                        || candidate.name().text() != selected.name().text()
                    {
                        return false;
                    }
                    let receiver = primitives::primitive_source(candidate.expression());
                    let same_receiver = receiver.kind() == SyntaxKind::Identifier
                        && (this.symbol(receiver) == this.symbol(selected_receiver)
                            || receiver.text() == selected_receiver.text());
                    let absent = absent.kind() == SyntaxKind::NullKeyword
                        || absent.kind() == SyntaxKind::Identifier && absent.text() == "undefined";
                    same_receiver && absent
                })
        }
        fn proves_absence_exit(
            this: &mut Lowerer<'_>,
            node: Node,
            selected: Node,
            selected_receiver: Node,
        ) -> bool {
            let node = primitives::primitive_source(node);
            if node.kind() == SyntaxKind::BinaryExpression
                && node.operator_token().kind() == SyntaxKind::BarBarToken
            {
                return (proves_absence_exit(this, node.left(), selected, selected_receiver)
                    && pure_data_guard(node.right()))
                    || (pure_data_guard(node.left())
                        && proves_absence_exit(this, node.right(), selected, selected_receiver));
            }
            same_absence_test(this, node, selected, selected_receiver)
        }
        proves_absence_exit(self, previous.expression(), selected, selected_receiver)
    }

    /// Recognize an immediately preceding validation guard of the form
    /// `value === null || typeof value !== "object" || Array.isArray(value)`
    /// whose selected branch throws. The continuation owns the union's sole
    /// record arm even when the public parameter annotation is `unknown`.
    pub(super) fn validated_record_value(&mut self, node: Node, value: &Expr) -> Option<Expr> {
        let Type::Union { union_id } = value.ty() else {
            return None;
        };
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(node);
        if symbol == 0 {
            return None;
        }
        let records = self.unions[union_id]
            .arms
            .iter()
            .enumerate()
            .filter_map(|(tag, arm)| matches!(arm, Type::Record { .. }).then(|| (tag, arm.clone())))
            .collect::<Vec<_>>();
        let [(tag, target)] = records.as_slice() else {
            return None;
        };
        let mut statement = node;
        let block = loop {
            let parent = statement.parent();
            if parent.is_nil()
                || matches!(
                    parent.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::MethodDeclaration
                        | SyntaxKind::Constructor
                )
            {
                return None;
            }
            if parent.kind() == SyntaxKind::Block {
                break parent;
            }
            statement = parent;
        };
        let statements = block.statements().into_iter().collect::<Vec<_>>();
        let index = statements
            .iter()
            .position(|candidate| *candidate == statement)?;
        let guard = *statements.get(index.checked_sub(1)?)?;
        if guard.kind() != SyntaxKind::IfStatement || !guard.else_statement().is_nil() {
            return None;
        }
        let exit = guard.then_statement();
        let throws = exit.kind() == SyntaxKind::ThrowStatement
            || (exit.kind() == SyntaxKind::Block
                && exit.statements().len() == 1
                && exit.statements().get(0).kind() == SyntaxKind::ThrowStatement);
        if !throws {
            return None;
        }
        fn collect(this: &mut Lowerer<'_>, node: Node, symbol: u32, facts: &mut [bool; 3]) -> bool {
            let node = primitives::primitive_source(node);
            if node.kind() == SyntaxKind::BinaryExpression
                && node.operator_token().kind() == SyntaxKind::BarBarToken
            {
                return collect(this, node.left(), symbol, facts)
                    && collect(this, node.right(), symbol, facts);
            }
            if node.kind() == SyntaxKind::CallExpression
                && node.arguments().len() == 1
                && node.question_dot_token().is_nil()
            {
                let callee = primitives::primitive_source(node.expression());
                let argument = primitives::primitive_source(node.arguments().get(0));
                if callee.kind() == SyntaxKind::PropertyAccessExpression {
                    let owner = this.symbol(callee.expression());
                    let member = this.symbol(callee.name());
                    if callee.name().text() == "isArray"
                        && callee.expression().kind() == SyntaxKind::Identifier
                        && argument.kind() == SyntaxKind::Identifier
                        && this.symbol(argument) == symbol
                        && this.primitive_symbol(owner, "Array", None)
                        && this.primitive_symbol(member, "isArray", Some("ArrayConstructor"))
                    {
                        facts[2] = true;
                        return true;
                    }
                }
            }
            if node.kind() != SyntaxKind::BinaryExpression {
                return false;
            }
            let op = node.operator_token().kind();
            let pairs = [(node.left(), node.right()), (node.right(), node.left())];
            if matches!(
                op,
                SyntaxKind::EqualsEqualsToken | SyntaxKind::EqualsEqualsEqualsToken
            ) && pairs.iter().copied().any(|(candidate, unit)| {
                let candidate = primitives::primitive_source(candidate);
                let unit = primitives::primitive_source(unit);
                candidate.kind() == SyntaxKind::Identifier
                    && this.symbol(candidate) == symbol
                    && unit.kind() == SyntaxKind::NullKeyword
            }) {
                facts[0] = true;
                return true;
            }
            if matches!(
                op,
                SyntaxKind::ExclamationEqualsToken | SyntaxKind::ExclamationEqualsEqualsToken
            ) && pairs.iter().copied().any(|(test, kind)| {
                let test = primitives::primitive_source(test);
                let kind = primitives::primitive_source(kind);
                test.kind() == SyntaxKind::TypeOfExpression
                    && primitives::primitive_source(test.expression()).kind()
                        == SyntaxKind::Identifier
                    && this.symbol(primitives::primitive_source(test.expression())) == symbol
                    && kind.kind() == SyntaxKind::StringLiteral
                    && kind.text() == "object"
            }) {
                facts[1] = true;
                return true;
            }
            false
        }
        let mut facts = [false; 3];
        if !collect(self, guard.expression(), symbol, &mut facts) || !facts.into_iter().all(|x| x) {
            return None;
        }
        Some(Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag: *tag,
            value: Box::new(value.clone()),
            r#type: target.clone(),
            loc: self.loc(node),
        })
    }

    /// `Array.isArray(value)` selects the unique array arm of an immutable
    /// tagged union. TypeScript can retain the recursive alias's owning union
    /// at the read site, so preserve the runtime tag proof explicitly.
    pub(super) fn array_guarded_value(&mut self, node: Node, value: &Expr) -> Option<Expr> {
        let Type::Union { union_id } = value.ty() else {
            return None;
        };
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(node);
        if symbol == 0 {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        if declaration.is_nil()
            || declaration.kind() != SyntaxKind::VariableDeclaration
            || !declaration.parent().flags().contains(NodeFlags::CONST)
        {
            return None;
        }
        let arrays = self.unions[union_id]
            .arms
            .iter()
            .enumerate()
            .filter_map(|(tag, arm)| matches!(arm, Type::Array { .. }).then(|| (tag, arm.clone())))
            .collect::<Vec<_>>();
        let [(tag, target)] = arrays.as_slice() else {
            return None;
        };
        let mut child = node;
        loop {
            let parent = child.parent();
            if parent.is_nil()
                || matches!(
                    parent.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::MethodDeclaration
                        | SyntaxKind::Constructor
                )
            {
                return None;
            }
            let selected = (parent.kind() == SyntaxKind::IfStatement
                && parent.then_statement() == child)
                .then(|| parent.expression())
                .or_else(|| {
                    (parent.kind() == SyntaxKind::ConditionalExpression
                        && parent.when_true() == child)
                        .then(|| parent.condition())
                });
            if let Some(condition) = selected {
                let condition = primitives::primitive_source(condition);
                if condition.kind() == SyntaxKind::CallExpression
                    && condition.arguments().len() == 1
                    && condition.question_dot_token().is_nil()
                {
                    let callee = primitives::primitive_source(condition.expression());
                    let argument = primitives::primitive_source(condition.arguments().get(0));
                    if callee.kind() == SyntaxKind::PropertyAccessExpression
                        && callee.name().text() == "isArray"
                        && callee.expression().kind() == SyntaxKind::Identifier
                        && argument.kind() == SyntaxKind::Identifier
                        && self.symbol(argument) == symbol
                    {
                        let owner = self.symbol(callee.expression());
                        let member = self.symbol(callee.name());
                        if self.primitive_symbol(owner, "Array", None)
                            && self.primitive_symbol(member, "isArray", Some("ArrayConstructor"))
                        {
                            return Some(Expr::UnionNarrow {
                                union_id: format!("u{union_id}"),
                                tag: *tag,
                                value: Box::new(value.clone()),
                                r#type: target.clone(),
                                loc: self.loc(node),
                            });
                        }
                    }
                }
            }
            child = parent;
        }
    }

    /// A completed `if (value.field)` read proves that an immutable receiver
    /// was present in either branch, even when the field itself was falsy.
    pub(super) fn nonoptional_property_guarded_value(
        &mut self,
        node: Node,
        value: &Expr,
    ) -> Option<Expr> {
        let Type::Union { union_id } = value.ty() else {
            return None;
        };
        if node.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(node);
        if symbol == 0 {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        if declaration.is_nil()
            || declaration.kind() != SyntaxKind::VariableDeclaration
            || !declaration.parent().flags().contains(NodeFlags::CONST)
        {
            return None;
        }
        let present = self.unions[union_id]
            .arms
            .iter()
            .enumerate()
            .filter(|(_, arm)| !matches!(arm, Type::Null | Type::Undefined | Type::Void))
            .collect::<Vec<_>>();
        let [(tag, target)] = present.as_slice() else {
            return None;
        };
        if self.unions[union_id].arms.len() == 1 {
            return None;
        }
        let tag = *tag;
        let target = (*target).clone();
        let mut child = node;
        loop {
            let parent = child.parent();
            if parent.is_nil() {
                return None;
            }
            if matches!(
                parent.kind(),
                SyntaxKind::FunctionDeclaration
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::MethodDeclaration
                    | SyntaxKind::Constructor
            ) {
                return None;
            }
            if parent.kind() == SyntaxKind::IfStatement
                && (parent.then_statement() == child || parent.else_statement() == child)
            {
                let guard = primitives::primitive_source(parent.expression());
                if guard.kind() == SyntaxKind::PropertyAccessExpression
                    && guard.question_dot_token().is_nil()
                    && !guard.flags().intersects(NodeFlags::OPTIONAL_CHAIN)
                {
                    let receiver = primitives::primitive_source(guard.expression());
                    if receiver.kind() == SyntaxKind::Identifier && self.symbol(receiver) == symbol
                    {
                        return Some(Expr::UnionNarrow {
                            union_id: format!("u{union_id}"),
                            tag,
                            value: Box::new(value.clone()),
                            r#type: target,
                            loc: self.loc(node),
                        });
                    }
                }
            }
            child = parent;
        }
    }

    fn same_truthy_guard_receiver(&mut self, left: Node, right: Node) -> bool {
        let left = primitives::primitive_source(left);
        let right = primitives::primitive_source(right);
        match (left.kind(), right.kind()) {
            (SyntaxKind::Identifier, SyntaxKind::Identifier) => {
                left.text() == right.text()
                    && (self.symbol(left) == 0 || self.symbol(left) == self.symbol(right))
            }
            (SyntaxKind::ThisKeyword, SyntaxKind::ThisKeyword) => true,
            (SyntaxKind::PropertyAccessExpression, SyntaxKind::PropertyAccessExpression) => {
                left.question_dot_token().is_nil()
                    && right.question_dot_token().is_nil()
                    && left.name().text() == right.name().text()
                    && self.same_truthy_guard_receiver(left.expression(), right.expression())
            }
            _ => false,
        }
    }

    /// Recognize the second read in `obj?.field ? use(obj.field) : ...`.
    /// Planned JavaScript fields normally retain their undefined arm even
    /// when the checker omits it. In this tightly bounded branch, however,
    /// the condition has just observed the same native record slot as
    /// truthy, and no source operation runs between the two reads.
    pub(super) fn directly_truthy_selected_property(&mut self, node: Node) -> bool {
        if node.kind() != SyntaxKind::PropertyAccessExpression {
            return false;
        }
        let branch = node.parent();
        if branch.kind() != SyntaxKind::CallExpression {
            return false;
        }
        let conditional = branch.parent();
        let condition = if conditional.kind() == SyntaxKind::ConditionalExpression
            && conditional.when_true() == branch
        {
            conditional.condition()
        } else {
            // Checked JavaScript commonly retains the published optional
            // storage ABI while the execution checker reports `any` for the
            // second read. Accept the first operation of `if (obj?.field) {
            // ... obj.field() ... }`: no intervening source operation can
            // invalidate the presence proof.
            let mut current = branch;
            loop {
                let parent = current.parent();
                let transparent = match parent.kind() {
                    SyntaxKind::AwaitExpression
                    | SyntaxKind::ParenthesizedExpression
                    | SyntaxKind::AsExpression
                    | SyntaxKind::TypeAssertionExpression
                    | SyntaxKind::NonNullExpression
                    | SyntaxKind::ExpressionStatement
                    | SyntaxKind::ReturnStatement => true,
                    SyntaxKind::VariableDeclaration => parent.initializer() == current,
                    SyntaxKind::VariableDeclarationList => parent.declarations().nodes().len() == 1,
                    SyntaxKind::VariableStatement => true,
                    _ => false,
                };
                if transparent {
                    current = parent;
                    continue;
                }
                if parent.kind() != SyntaxKind::Block
                    || parent.statements().is_empty()
                    || parent.statements().get(0) != current
                {
                    return false;
                }
                let statement = parent.parent();
                if statement.kind() != SyntaxKind::IfStatement
                    || statement.then_statement() != parent
                {
                    return false;
                }
                break statement.expression();
            }
        };
        let condition = primitives::primitive_source(condition);
        if condition.kind() != SyntaxKind::PropertyAccessExpression
            || condition.name().text() != node.name().text()
        {
            return false;
        }
        let guarded = primitives::primitive_source(condition.expression());
        let selected = primitives::primitive_source(node.expression());
        self.same_truthy_guard_receiver(guarded, selected)
            && branch
                .arguments()
                .into_iter()
                .filter(|argument| argument.end() <= node.pos())
                .all(|argument| {
                    matches!(
                        primitives::primitive_source(argument).kind(),
                        SyntaxKind::Identifier
                            | SyntaxKind::NumericLiteral
                            | SyntaxKind::StringLiteral
                            | SyntaxKind::TrueKeyword
                            | SyntaxKind::FalseKeyword
                            | SyntaxKind::NullKeyword
                    )
                })
    }

    /// Recognize a local predicate whose complete body is a conjunction of
    /// `"field" in parameter` tests. When that key set selects exactly one
    /// record arm, a true conditional branch may use that arm's owning view.
    /// The call itself remains in the IR, so evaluation and exceptions retain
    /// JavaScript order; this only records what a true result proved.
    pub(super) fn presence_guard_union_arm(
        &mut self,
        condition: Node,
        selected: Node,
        source: &Type,
        target: &Type,
    ) -> Option<usize> {
        let Type::Union { union_id } = source else {
            return None;
        };
        let Type::Record {
            shape_id: target_shape,
        } = target
        else {
            return None;
        };
        let condition = primitives::primitive_source(condition);
        let selected = primitives::primitive_source(selected);
        if condition.kind() != SyntaxKind::CallExpression
            || selected.kind() != SyntaxKind::Identifier
            || condition.arguments().len() != 1
            || !condition.question_dot_token().is_nil()
        {
            return None;
        }
        let argument = primitives::primitive_source(condition.arguments().get(0));
        if argument.kind() != SyntaxKind::Identifier
            || self.symbol(argument) != self.symbol(selected)
        {
            return None;
        }
        let callee = primitives::primitive_source(condition.expression());
        if callee.kind() != SyntaxKind::Identifier {
            return None;
        }
        let callee_symbol = self.symbol(callee);
        if callee_symbol == 0 {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(callee_symbol)).value_declaration;
        if declaration.is_nil()
            || declaration.kind() != SyntaxKind::FunctionDeclaration
            || declaration.body().is_nil()
            || declaration.parameters().len() != 1
            || declaration.parameters().get(0).name().kind() != SyntaxKind::Identifier
        {
            return None;
        }
        let statements = declaration.body().statements();
        if statements.len() != 1 || statements.get(0).kind() != SyntaxKind::ReturnStatement {
            return None;
        }
        let parameter = self.symbol(declaration.parameters().get(0).name());
        let mut keys = Vec::new();
        fn collect(
            this: &mut Lowerer<'_>,
            node: Node,
            parameter: u32,
            keys: &mut Vec<String>,
        ) -> bool {
            let node = primitives::primitive_source(node);
            if node.kind() != SyntaxKind::BinaryExpression {
                return false;
            }
            if node.operator_token().kind() == SyntaxKind::AmpersandAmpersandToken {
                return collect(this, node.left(), parameter, keys)
                    && collect(this, node.right(), parameter, keys);
            }
            if node.operator_token().kind() != SyntaxKind::InKeyword {
                return false;
            }
            let receiver = primitives::primitive_source(node.right());
            let key = primitives::primitive_source(node.left());
            if receiver.kind() != SyntaxKind::Identifier
                || this.symbol(receiver) != parameter
                || !matches!(
                    key.kind(),
                    SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
                )
            {
                return false;
            }
            keys.push(key.text().to_string());
            true
        }
        if parameter == 0
            || !collect(self, statements.get(0).expression(), parameter, &mut keys)
            || keys.is_empty()
        {
            return None;
        }
        let target_record = self.records.get(*target_shape)?;
        if !keys
            .iter()
            .all(|key| target_record.fields.iter().any(|field| field.name == *key))
        {
            return None;
        }
        let arms = &self.unions[*union_id].arms;
        let target_type = Type::Record {
            shape_id: *target_shape,
        };
        let tag = arms.iter().position(|arm| {
            crate::ir::record_views::view_pairs(arm, &target_type, &self.records, &self.unions)
                .is_some()
        })?;
        let unique = arms.iter().enumerate().all(|(index, arm)| {
            if index == tag {
                return true;
            }
            let Type::Record { shape_id } = arm else {
                return false;
            };
            self.records.get(*shape_id).is_some_and(|record| {
                keys.iter()
                    .any(|key| !record.fields.iter().any(|field| field.name == *key))
            })
        });
        unique.then_some(tag)
    }

    fn const_initializer(&self, symbol: u32) -> Option<Node> {
        if symbol == 0 {
            return None;
        }
        let declaration = self.checker.sym(SymbolId(symbol)).value_declaration;
        if declaration.is_nil()
            || declaration.kind() != SyntaxKind::VariableDeclaration
            || declaration.name().kind() != SyntaxKind::Identifier
            || !declaration.parent().flags().intersects(NodeFlags::CONST)
            || declaration.initializer().is_nil()
        {
            return None;
        }
        Some(primitives::primitive_source(declaration.initializer()))
    }

    fn literal_zero(&self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        node.kind() == SyntaxKind::NumericLiteral
            && source_frontend::jsnum::from_string(&node.text().replace('_', "")).value() == 0.0
    }

    fn pure_prior_argument(&mut self, node: Node) -> bool {
        let node = primitives::primitive_source(node);
        if node.kind() == SyntaxKind::Identifier {
            return self.binding(node).is_ok();
        }
        if matches!(
            node.kind(),
            SyntaxKind::NumericLiteral | SyntaxKind::StringLiteral
        ) {
            return true;
        }
        if node.kind() != SyntaxKind::PropertyAccessExpression
            || node.name().text() != "length"
            || !node.question_dot_token().is_nil()
            || node.expression().kind() != SyntaxKind::Identifier
        {
            return false;
        }
        self.binding(node.expression())
            .is_ok_and(|local| matches!(local.r#type, Type::Array { .. }))
    }

    fn const_boolean_proves_nonnull(&mut self, condition: Node, symbol: u32, truth: bool) -> bool {
        let condition = primitives::primitive_source(condition);
        if condition.kind() == SyntaxKind::PrefixUnaryExpression
            && condition.operator() == SyntaxKind::ExclamationToken
        {
            return self.const_boolean_proves_nonnull(condition.operand(), symbol, !truth);
        }
        if condition.kind() != SyntaxKind::BinaryExpression {
            return false;
        }
        let op = condition.operator_token().kind();
        if (op == SyntaxKind::AmpersandAmpersandToken && truth)
            || (op == SyntaxKind::BarBarToken && !truth)
        {
            return self.const_boolean_proves_nonnull(condition.left(), symbol, truth)
                || self.const_boolean_proves_nonnull(condition.right(), symbol, truth);
        }
        if !((op == SyntaxKind::ExclamationEqualsToken && truth)
            || (op == SyntaxKind::EqualsEqualsToken && !truth))
        {
            return false;
        }
        let left = primitives::primitive_source(condition.left());
        let right = primitives::primitive_source(condition.right());
        (left.kind() == SyntaxKind::Identifier
            && self.symbol(left) == symbol
            && right.kind() == SyntaxKind::NullKeyword)
            || (right.kind() == SyntaxKind::Identifier
                && self.symbol(right) == symbol
                && left.kind() == SyntaxKind::NullKeyword)
    }

    /// An immutable boolean derived from an immutable nullable value can retain
    /// a non-null proof in the selected branch, including inside loops.
    pub(super) fn guarded_const_boolean_argument(
        &mut self,
        node: Node,
        value: Expr,
        target: &Type,
    ) -> Option<Expr> {
        if node.kind() != SyntaxKind::NonNullExpression || *target != Type::F64 {
            return None;
        }
        let source = primitives::primitive_source(node.expression());
        if source.kind() != SyntaxKind::Identifier {
            return None;
        }
        let symbol = self.symbol(source);
        self.const_initializer(symbol)?;
        let Type::Union { union_id } = value.ty() else {
            return None;
        };
        let arms = &self.unions[union_id].arms;
        if !arms
            .iter()
            .all(|arm| matches!(arm, Type::F64 | Type::Null | Type::Undefined))
        {
            return None;
        }
        let tag = arms.iter().position(|arm| *arm == Type::F64)?;
        let mut child = node;
        loop {
            let parent = child.parent();
            if parent.is_nil()
                || matches!(
                    parent.kind(),
                    SyntaxKind::FunctionDeclaration
                        | SyntaxKind::FunctionExpression
                        | SyntaxKind::ArrowFunction
                        | SyntaxKind::MethodDeclaration
                        | SyntaxKind::Constructor
                )
            {
                return None;
            }
            let selected = if parent.kind() == SyntaxKind::IfStatement
                && parent.then_statement() == child
            {
                Some((parent.expression(), true))
            } else if parent.kind() == SyntaxKind::IfStatement && parent.else_statement() == child {
                Some((parent.expression(), false))
            } else if parent.kind() == SyntaxKind::ConditionalExpression
                && parent.when_true() == child
            {
                Some((parent.condition(), true))
            } else if parent.kind() == SyntaxKind::ConditionalExpression
                && parent.when_false() == child
            {
                Some((parent.condition(), false))
            } else {
                None
            };
            if let Some((guard, mut truth)) = selected {
                let mut guard = primitives::primitive_source(guard);
                if guard.kind() == SyntaxKind::PrefixUnaryExpression
                    && guard.operator() == SyntaxKind::ExclamationToken
                {
                    guard = primitives::primitive_source(guard.operand());
                    truth = !truth;
                }
                if guard.kind() == SyntaxKind::Identifier {
                    let guard_symbol = self.symbol(guard);
                    if let Some(initializer) = self.const_initializer(guard_symbol)
                        && self.const_boolean_proves_nonnull(initializer, symbol, truth)
                    {
                        return Some(Expr::UnionNarrow {
                            union_id: format!("u{union_id}"),
                            tag,
                            value: Box::new(value),
                            r#type: target.clone(),
                            loc: self.loc(node),
                        });
                    }
                }
            }
            child = parent;
        }
    }

    /// If `const d = x == null ? 0 : ...` and `d !== 0`, immutable x is
    /// non-nullish. Only use the proof in an immediately selected call arm:
    /// no preceding argument may invoke user code or mutate observable state.
    pub(super) fn guarded_derived_argument(
        &mut self,
        node: Node,
        value: Expr,
        target: &Type,
    ) -> Option<Expr> {
        if node.kind() != SyntaxKind::NonNullExpression || *target != Type::F64 {
            return None;
        }
        let source = primitives::primitive_source(node.expression());
        if source.kind() != SyntaxKind::Identifier {
            return None;
        }
        let source_symbol = self.symbol(source);
        self.const_initializer(source_symbol)?;
        let Type::Union { union_id } = value.ty() else {
            return None;
        };
        let arms = &self.unions[union_id].arms;
        if !arms
            .iter()
            .all(|arm| matches!(arm, Type::F64 | Type::Null | Type::Undefined))
        {
            return None;
        }
        let tag = arms.iter().position(|arm| *arm == Type::F64)?;
        let call = node.parent();
        if call.kind() != SyntaxKind::CallExpression
            || call.expression().kind() != SyntaxKind::Identifier
            || !call.question_dot_token().is_nil()
        {
            return None;
        }
        let args = call.arguments().into_iter().collect::<Vec<_>>();
        let index = args.iter().position(|arg| *arg == node)?;
        if !args[..index]
            .iter()
            .all(|arg| self.pure_prior_argument(*arg))
        {
            return None;
        }
        let conditional = call.parent();
        if conditional.kind() != SyntaxKind::ConditionalExpression {
            return None;
        }
        let guard = primitives::primitive_source(conditional.condition());
        if guard.kind() != SyntaxKind::BinaryExpression {
            return None;
        }
        let branch_unequal = match guard.operator_token().kind() {
            SyntaxKind::EqualsEqualsEqualsToken => conditional.when_false() == call,
            SyntaxKind::ExclamationEqualsEqualsToken => conditional.when_true() == call,
            _ => false,
        };
        if !branch_unequal {
            return None;
        }
        let derived = if self.literal_zero(guard.right()) {
            primitives::primitive_source(guard.left())
        } else if self.literal_zero(guard.left()) {
            primitives::primitive_source(guard.right())
        } else {
            return None;
        };
        if derived.kind() != SyntaxKind::Identifier {
            return None;
        }
        let derived_symbol = self.symbol(derived);
        let initializer = self.const_initializer(derived_symbol)?;
        if initializer.kind() != SyntaxKind::ConditionalExpression
            || !self.literal_zero(initializer.when_true())
        {
            return None;
        }
        let condition = primitives::primitive_source(initializer.condition());
        if condition.kind() != SyntaxKind::BinaryExpression
            || condition.operator_token().kind() != SyntaxKind::EqualsEqualsToken
        {
            return None;
        }
        let (candidate, unit) = (
            primitives::primitive_source(condition.left()),
            primitives::primitive_source(condition.right()),
        );
        let mut proven = |value: Node, null: Node| {
            value.kind() == SyntaxKind::Identifier
                && self.symbol(value) == source_symbol
                && null.kind() == SyntaxKind::NullKeyword
        };
        if !proven(candidate, unit) && !proven(unit, candidate) {
            return None;
        }
        Some(Expr::UnionNarrow {
            union_id: format!("u{union_id}"),
            tag,
            value: Box::new(value),
            r#type: target.clone(),
            loc: self.loc(node),
        })
    }
}
