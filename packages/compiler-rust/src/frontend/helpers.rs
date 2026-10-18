//! Typed synthetic functions keep collection loops inside the portable IR.
use super::*;

pub(super) struct Helper {
    pub function: Function,
}

impl Helper {
    pub fn new(kind: &str, types: Vec<Type>, result: Type, loc: Loc) -> Self {
        let params = types
            .into_iter()
            .enumerate()
            .map(|(i, r#type)| Param {
                local_id: format!("p{i}"),
                name: format!("arg{i}"),
                r#type,
            })
            .collect::<Vec<_>>();
        let locals = params
            .iter()
            .map(|p| Local {
                id: p.local_id.clone(),
                name: p.name.clone(),
                r#type: p.r#type.clone(),
                mutable: false,
                boxed: false,
            })
            .collect();
        Self {
            function: Function {
                rest: false,
                name: kind.into(),
                params,
                captures: None,
                return_type: result,
                locals,
                body: vec![],
                loc,
            },
        }
    }
    pub fn local(&mut self, name: &str, ty: Type, mutable: bool) -> Local {
        let local = Local {
            id: format!("v{}", self.function.locals.len()),
            name: name.into(),
            r#type: ty,
            mutable,
            boxed: false,
        };
        self.function.locals.push(local.clone());
        local
    }
    pub fn param(&self, index: usize) -> Local {
        self.function.locals[index].clone()
    }
    pub fn loc(&self) -> Loc {
        self.function.loc.clone()
    }
    pub fn read(&self, local: &Local) -> Expr {
        Expr::VarRef {
            local_id: local.id.clone(),
            r#type: local.r#type.clone(),
            loc: self.loc(),
        }
    }
    pub fn number(&self, value: f64) -> Expr {
        Expr::NumLit {
            value,
            spelling: None,
            r#type: Type::F64,
            loc: self.loc(),
        }
    }
    pub fn declare(&mut self, local: &Local, init: Expr) {
        self.function.body.push(Stmt::VarDecl {
            local_id: local.id.clone(),
            init,
            loc: self.loc(),
        });
    }
    pub fn length(&self, array: &Local) -> Expr {
        Expr::ArrayIntrinsic {
            method: "length".into(),
            receiver: Box::new(self.read(array)),
            args: vec![],
            r#type: Type::F64,
            loc: self.loc(),
        }
    }
    pub fn get(&self, array: &Local, index: &Local, ty: Type) -> Expr {
        Expr::ArrayGet {
            arr: Box::new(self.read(array)),
            index: Box::new(self.read(index)),
            r#type: ty,
            loc: self.loc(),
        }
    }
    pub fn advance(&self, index: &Local) -> Stmt {
        Stmt::Assign {
            local_id: index.id.clone(),
            value: Expr::Bin {
                op: "+".into(),
                left: Box::new(self.read(index)),
                right: Box::new(self.number(1.0)),
                r#type: Type::F64,
                loc: self.loc(),
            },
            initializes_global: false,
            loc: self.loc(),
        }
    }
    pub fn less(&self, index: &Local, limit: Expr) -> Expr {
        Expr::Bin {
            op: "<".into(),
            left: Box::new(self.read(index)),
            right: Box::new(limit),
            r#type: Type::Bool,
            loc: self.loc(),
        }
    }
    pub fn finish(mut self, result: &Local) -> Function {
        self.function.body.push(Stmt::Return {
            value: Some(self.read(result)),
            loc: self.loc(),
        });
        self.function
    }
}

impl Lowerer<'_> {
    pub(super) fn install_helper(&mut self, mut function: Function) -> String {
        let key = (
            function.name.clone(),
            function
                .params
                .iter()
                .map(|p| p.r#type.clone())
                .collect::<Vec<_>>(),
            function.return_type.clone(),
        );
        if let Some(name) = self.helpers.get(&key) {
            return name.clone();
        }
        function.name = format!("native_{}_{}", function.name, self.helpers.len());
        let name = function.name.clone();
        self.helpers.insert(key, name.clone());
        self.lifted.push(function);
        name
    }
}
