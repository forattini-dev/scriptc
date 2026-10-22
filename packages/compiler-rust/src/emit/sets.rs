//! Set operations use the same traced owning storage as native maps.
use super::*;

pub(super) fn expression(value: &Expr, function: &Function, module: &Module) -> Option<String> {
    let equality = |elem: &Type| {
        if *elem == Type::F64 {
            "a == b || (a.is_nan() && b.is_nan())"
        } else if *elem == Type::Dyn {
            "native_value_same_key(a, b)"
        } else if *elem == Type::Symbol {
            "runtime::symbol_ptr_eq(a, b)"
        } else if matches!(elem, Type::Record { .. } | Type::Func { .. }) {
            "a.ptr_eq(b)"
        } else {
            "a == b"
        }
    };
    let normalize = |elem: &Type, value: &str| {
        if *elem == Type::F64 {
            format!("if {value} == 0.0 {{ 0.0 }} else {{ {value} }}")
        } else if *elem == Type::Dyn {
            format!("native_map_key({value})")
        } else {
            value.into()
        }
    };
    Some(match value {
        Expr::SetNew {
            seed,
            r#type: Type::Set { elem },
            ..
        } => {
            let ty = rust_type((**elem).clone(), module);
            let insert = format!(
                "let value = {}; if !entries.iter().any(|(a, _): &({ty}, bool)| {{ let b = &value; {} }}) {{ entries.push((value, true)); }}",
                normalize(elem, "value"),
                equality(elem)
            );
            let seed = seed.as_ref().map(|seed| format!("let seed = {}; let length = runtime::array_len(&seed) as usize; for index in 0..length {{ let value = {} ; {insert} }}", expr(seed, function, module), "runtime::array_get(&seed, index as f64)")).unwrap_or_default();
            format!(
                "{{ let mut entries: Vec<({ty}, bool)> = Vec::new(); {seed} runtime::Gc::new(NativeMap {{ entries }}) }}"
            )
        }
        Expr::SetIntrinsic {
            receiver,
            method,
            args,
            ..
        } => {
            let Type::Set { elem } = receiver.ty() else {
                unreachable!("IR validated")
            };
            let arguments = args
                .iter()
                .enumerate()
                .map(|(i, arg)| format!("let arg{i} = {};", expr(arg, function, module)))
                .collect::<String>();
            let equal = equality(&elem);
            let operation = match method.as_str() {
                "size" => "set.with(|set| set.entries.len() as f64)".into(),
                "clear" => "set.with_mut(|set| set.entries.clear())".into(),
                "has" => format!(
                    "set.with(|set| set.entries.iter().any(|(a,_)| {{ let b = &arg0; {equal} }}))"
                ),
                "delete" => format!(
                    "set.with_mut(|set| if let Some(index) = set.entries.iter().position(|(a,_)| {{ let b = &arg0; {equal} }}) {{ set.entries.remove(index); true }} else {{ false }})"
                ),
                "add" => format!(
                    "{{ let arg0 = {}; set.with_mut(|set| if !set.entries.iter().any(|(a,_)| {{ let b = &arg0; {equal} }}) {{ set.entries.push((arg0, true)); }}); }}",
                    normalize(&elem, "arg0")
                ),
                _ => unreachable!("IR validated"),
            };
            format!(
                "{{ let set = {}; {arguments} {operation} }}",
                expr(receiver, function, module)
            )
        }
        _ => return None,
    })
}
