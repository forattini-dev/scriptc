//! Process handles and asynchronous capture use the retained portable IR kinds.
use super::*;

pub fn signature(name: &str, args: &[Type], result: &Type, module: &Module) -> Option<bool> {
    let dyn_array = Type::Array {
        elem: Box::new(Type::Dyn),
    };
    Some(match name {
        "cp.spawnSyncUtf8" => {
            args == [
                Type::String,
                Type::Array {
                    elem: Box::new(Type::String),
                },
                Type::Dyn,
            ] && *result == Type::Dyn
        }
        "cp.spawn" => {
            args == [
                Type::String,
                Type::Array {
                    elem: Box::new(Type::String),
                },
                Type::Dyn,
            ] && *result == Type::Child
        }
        "child.on" | "child.once" => {
            args == [Type::Child, Type::String, Type::Dyn] && *result == Type::Child
        }
        "bun.spawnSync" => {
            args == [
                Type::Array {
                    elem: Box::new(Type::String),
                },
                Type::F64,
                Type::F64,
                Type::F64,
            ] && *result == Type::Dyn
        }
        "cp.execFileSyncUtf8" => {
            args == [
                Type::String,
                Type::Array {
                    elem: Box::new(Type::String),
                },
                Type::Dyn,
            ] && *result == Type::String
        }
        "cp.execFileNative" | "cp.execNative" => args == [dyn_array] && *result == Type::Child,
        "cp.execFilePromise" | "cp.execPromise" => {
            args == [dyn_array]
                && matches!(result, Type::Promise { inner } if matches!(inner.as_ref(), Type::Record { shape_id } if module.records.get(*shape_id).is_some_and(|r| !r.tuple && r.index_value.is_none() && r.fields.len() == 2 && ["stdout", "stderr"].iter().all(|name| r.fields.iter().any(|f| f.name == *name && f.r#type == Type::String)))))
        }
        "cp.promiseChild" => {
            args.len() == 1 && matches!(args[0], Type::Promise { .. }) && *result == Type::Child
        }
        "child.killed" => args == [Type::Child] && *result == Type::Bool,
        "child.unref" => args == [Type::Child] && *result == Type::Void,
        "child.kill" => args == [Type::Child, Type::String] && *result == Type::Bool,
        "child.stdout" | "child.stderr" => args == [Type::Child] && *result == Type::Dyn,
        "child.pid" | "child.exitCode" => {
            args == [Type::Child]
                && ((*result == Type::F64 && name == "child.pid")
                    || matches!(result, Type::Union { union_id } if module.unions.get(*union_id).is_some_and(|u| u.arms.len() == 2 && u.arms.contains(&Type::F64) && u.arms.contains(if name == "child.pid" { &Type::Undefined } else { &Type::Null }))))
        }
        "child.signalCode" => {
            args == [Type::Child]
                && matches!(result, Type::Union { union_id } if module.unions.get(*union_id).is_some_and(|u| u.arms.len() == 2 && u.arms.contains(&Type::String) && u.arms.contains(&Type::Null)))
        }
        _ => return None,
    })
}
