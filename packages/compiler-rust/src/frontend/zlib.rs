//! A small synchronous zlib ABI reuses the shared engine-free Rust runtime.
use super::*;

impl Lowerer<'_> {
    pub(super) fn zlib_call(&mut self, node: Node, member: &str) -> Result<Expr, String> {
        let args = node.arguments().into_iter().collect::<Vec<_>>();
        if args.is_empty()
            || args.len() > 2
            || (member != "deflateSync" && args.len() != 1)
            || args
                .iter()
                .any(|arg| arg.kind() == SyntaxKind::SpreadElement)
        {
            return Err(self.refuse(
                node,
                "zlib sync needs one byte view and an optional literal deflate level",
            ));
        }
        let input = self.expression(args[0])?;
        if input.ty() != Type::bytes() {
            return Err(self.refuse(
                args[0],
                "zlib sync input requires a represented Uint8Array or Buffer",
            ));
        }
        let mut lowered = vec![input];
        let operation = if args.len() == 2 {
            let options = receivers::reference_node(args[1]);
            if options.kind() != SyntaxKind::ObjectLiteralExpression {
                return Err(self.refuse(args[1], "deflateSync options require a literal level"));
            }
            let properties = options.properties().into_iter().collect::<Vec<_>>();
            if properties.len() != 1
                || properties[0].kind() != SyntaxKind::PropertyAssignment
                || self.data_property_name(properties[0].name()).as_deref() != Some("level")
            {
                return Err(
                    self.refuse(options, "deflateSync supports only a literal level option")
                );
            }
            let level = receivers::reference_node(properties[0].initializer());
            let value = if level.kind() == SyntaxKind::NumericLiteral {
                level.text().parse::<f64>().ok()
            } else if level.kind() == SyntaxKind::PrefixUnaryExpression
                && level.operator() == SyntaxKind::MinusToken
                && level.operand().kind() == SyntaxKind::NumericLiteral
            {
                level.operand().text().parse::<f64>().ok().map(|n| -n)
            } else {
                None
            };
            let Some(value) = value.filter(|n| (-1.0..=9.0).contains(n) && n.fract() == 0.0) else {
                return Err(self.refuse(
                    level,
                    "deflateSync level requires a literal integer from -1 through 9",
                ));
            };
            lowered.push(Expr::NumLit {
                value,
                spelling: None,
                r#type: Type::F64,
                loc: self.loc(level),
            });
            "zlib.deflateSyncLevel"
        } else if member == "deflateSync" {
            "zlib.deflateSync"
        } else if member == "inflateSync" {
            "zlib.inflateSync"
        } else if member == "gzipSync" {
            "zlib.gzipSync"
        } else {
            "zlib.gunzipSync"
        };
        Ok(Expr::LibCall {
            r#fn: operation.into(),
            args: lowered,
            r#type: Type::bytes(),
            loc: self.loc(node),
        })
    }
}
