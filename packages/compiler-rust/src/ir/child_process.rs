//! Process handles and asynchronous capture use the retained portable IR kinds.
use super::*;

pub fn signature(name: &str, args: &[Type], result: &Type, module: &Module) -> Option<bool> {
    let dyn_array = Type::Array {
        elem: Box::new(Type::Dyn),
    };
    Some(match name {
        "cp.execFileNative" => args == [dyn_array] && *result == Type::Child,
        "cp.execFilePromise" => {
            args == [dyn_array]
                && matches!(result, Type::Promise { inner } if matches!(inner.as_ref(), Type::Record { shape_id } if module.records.get(*shape_id).is_some_and(|r| !r.tuple && r.index_value.is_none() && r.fields.len() == 2 && ["stdout", "stderr"].iter().all(|name| r.fields.iter().any(|f| f.name == *name && f.r#type == Type::String)))))
        }
        "cp.promiseChild" => {
            args.len() == 1 && matches!(args[0], Type::Promise { .. }) && *result == Type::Child
        }
        "child.killed" => args == [Type::Child] && *result == Type::Bool,
        "child.pid" | "child.exitCode" => {
            args == [Type::Child]
                && matches!(result, Type::Union { union_id } if module.unions.get(*union_id).is_some_and(|u| u.arms.len() == 2 && u.arms.contains(&Type::F64) && u.arms.contains(if name == "child.pid" { &Type::Undefined } else { &Type::Null })))
        }
        _ => return None,
    })
}
