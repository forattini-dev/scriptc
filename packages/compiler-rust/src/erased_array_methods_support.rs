// Array.prototype methods on erased (dynamic) arrays. Each operation reads the
// receiver's length once, skips holes where the specification does, invokes
// callbacks with (value, index, array) and an optional thisArg, and returns
// owning NativeValue results. No source text is evaluated.
fn native_array_dyn_method_index(key: &runtime::JsString) -> Option<u8> {
    Some(match key.well_formed_utf8().unwrap_or("") {
        "filter" => 0,
        "find" => 1,
        "findIndex" => 2,
        "findLast" => 3,
        "findLastIndex" => 4,
        "forEach" => 5,
        "flatMap" => 6,
        "flat" => 7,
        "includes" => 8,
        "slice" => 9,
        "reduce" => 10,
        "concat" => 11,
        "at" => 12,
        _ => return None,
    })
}

fn native_array_dyn_method_name(method: u8) -> &'static str {
    match method {
        0 => "Array.prototype.filter",
        1 => "Array.prototype.find",
        2 => "Array.prototype.findIndex",
        3 => "Array.prototype.findLast",
        4 => "Array.prototype.findLastIndex",
        5 => "Array.prototype.forEach",
        6 => "Array.prototype.flatMap",
        7 => "Array.prototype.flat",
        8 => "Array.prototype.includes",
        9 => "Array.prototype.slice",
        10 => "Array.prototype.reduce",
        11 => "Array.prototype.concat",
        _ => "Array.prototype.at",
    }
}

fn native_array_dyn_callback(args: &[NativeValue], name: &str) -> (NativeValue, NativeValue) {
    let callback = args.first().cloned().unwrap_or(NativeValue::Undefined);
    if !native_value_is_function(&callback) {
        runtime::throw_type_error(format!("{name} callback is not a function"));
    }
    (callback, args.get(1).cloned().unwrap_or(NativeValue::Undefined))
}

fn native_array_dyn_relative(value: Option<&NativeValue>, length: f64, default: f64) -> f64 {
    let Some(value) = value.filter(|value| !matches!(value, NativeValue::Undefined)) else {
        return default;
    };
    let number = native_compare_number(value);
    let integer = if number.is_nan() { 0.0 } else { number.trunc() };
    if integer < 0.0 {
        (length + integer).max(0.0)
    } else {
        integer.min(length)
    }
}

fn native_array_dyn_flatten_into(target: &runtime::JsArray<NativeValue>, value: NativeValue, depth: f64) {
    if depth > 0.0 && native_value_is_array(&value) {
        let length = native_array_map_length(&value);
        for index in 0..length as usize {
            if let Some(item) = native_array_map_slot(&value, index as f64) {
                native_array_dyn_flatten_into(target, item, depth - 1.0);
            }
        }
    } else {
        runtime::array_push(target, value);
    }
}

fn native_array_dyn_call(receiver: NativeValue, args: Vec<NativeValue>, method: u8) -> NativeValue {
    let name = native_array_dyn_method_name(method);
    let length = native_array_map_length(&receiver);
    let invoke = |callback: &NativeValue, this_arg: &NativeValue, value: NativeValue, index: usize| {
        native_value_call_with_this(
            callback.clone(),
            this_arg.clone(),
            vec![value, NativeValue::Number(index as f64), receiver.clone()],
            name,
        )
    };
    match method {
        0 => {
            let (callback, this_arg) = native_array_dyn_callback(&args, name);
            let result = runtime::array_new::<NativeValue>(Vec::new());
            for index in 0..length as usize {
                if let Some(value) = native_array_map_slot(&receiver, index as f64) {
                    let selected = invoke(&callback, &this_arg, value.clone(), index);
                    if native_value_test(&selected, "truthy") {
                        runtime::array_push(&result, value);
                    }
                }
            }
            NativeValue::Array(result)
        }
        1 | 2 => {
            let (callback, this_arg) = native_array_dyn_callback(&args, name);
            for index in 0..length as usize {
                let value = native_array_map_slot(&receiver, index as f64).unwrap_or(NativeValue::Undefined);
                if native_value_test(&invoke(&callback, &this_arg, value.clone(), index), "truthy") {
                    return if method == 1 { value } else { NativeValue::Number(index as f64) };
                }
            }
            if method == 1 { NativeValue::Undefined } else { NativeValue::Number(-1.0) }
        }
        3 | 4 => {
            let (callback, this_arg) = native_array_dyn_callback(&args, name);
            for index in (0..length as usize).rev() {
                let value = native_array_map_slot(&receiver, index as f64).unwrap_or(NativeValue::Undefined);
                if native_value_test(&invoke(&callback, &this_arg, value.clone(), index), "truthy") {
                    return if method == 3 { value } else { NativeValue::Number(index as f64) };
                }
            }
            if method == 3 { NativeValue::Undefined } else { NativeValue::Number(-1.0) }
        }
        5 => {
            let (callback, this_arg) = native_array_dyn_callback(&args, name);
            for index in 0..length as usize {
                if let Some(value) = native_array_map_slot(&receiver, index as f64) {
                    invoke(&callback, &this_arg, value, index);
                }
            }
            NativeValue::Undefined
        }
        6 => {
            let (callback, this_arg) = native_array_dyn_callback(&args, name);
            let result = runtime::array_new::<NativeValue>(Vec::new());
            for index in 0..length as usize {
                if let Some(value) = native_array_map_slot(&receiver, index as f64) {
                    let mapped = invoke(&callback, &this_arg, value, index);
                    native_array_dyn_flatten_into(&result, mapped, 1.0);
                }
            }
            NativeValue::Array(result)
        }
        7 => {
            let depth = match args.first() {
                None | Some(NativeValue::Undefined) => 1.0,
                Some(value) => {
                    let depth = native_compare_number(value);
                    if depth.is_nan() { 0.0 } else { depth.trunc() }
                }
            };
            let result = runtime::array_new::<NativeValue>(Vec::new());
            for index in 0..length as usize {
                if let Some(value) = native_array_map_slot(&receiver, index as f64) {
                    native_array_dyn_flatten_into(&result, value, depth);
                }
            }
            NativeValue::Array(result)
        }
        8 => {
            let needle = args.first().cloned().unwrap_or(NativeValue::Undefined);
            let start = native_array_dyn_relative(args.get(1), length, 0.0);
            for index in start as usize..length as usize {
                let value = native_array_map_slot(&receiver, index as f64).unwrap_or(NativeValue::Undefined);
                if native_value_same_key(&value, &needle) {
                    return NativeValue::Boolean(true);
                }
            }
            NativeValue::Boolean(false)
        }
        9 => {
            let start = native_array_dyn_relative(args.first(), length, 0.0);
            let end = native_array_dyn_relative(args.get(1), length, length);
            let result = runtime::array_new::<NativeValue>(Vec::new());
            runtime::array_set_length(&result, (end - start).max(0.0));
            let mut target = 0.0;
            let mut index = start;
            while index < end {
                match native_array_map_slot(&receiver, index) {
                    Some(NativeValue::Undefined) => runtime::array_set_undefined(&result, target),
                    Some(value) => runtime::array_set(&result, target, value),
                    None => {}
                }
                index += 1.0;
                target += 1.0;
            }
            NativeValue::Array(result)
        }
        10 => {
            let callback = args.first().cloned().unwrap_or(NativeValue::Undefined);
            if !native_value_is_function(&callback) {
                runtime::throw_type_error(format!("{name} callback is not a function"));
            }
            let mut index = 0;
            let mut accumulator = if args.len() >= 2 {
                args[1].clone()
            } else {
                loop {
                    if index >= length as usize {
                        runtime::throw_type_error("Reduce of empty array with no initial value".into());
                    }
                    if let Some(value) = native_array_map_slot(&receiver, index as f64) {
                        index += 1;
                        break value;
                    }
                    index += 1;
                }
            };
            while index < length as usize {
                if let Some(value) = native_array_map_slot(&receiver, index as f64) {
                    accumulator = native_value_call_with_this(
                        callback.clone(),
                        NativeValue::Undefined,
                        vec![accumulator, value, NativeValue::Number(index as f64), receiver.clone()],
                        name,
                    );
                }
                index += 1;
            }
            accumulator
        }
        11 => {
            let result = runtime::array_new::<NativeValue>(Vec::new());
            for source in std::iter::once(receiver.clone()).chain(args) {
                if native_value_is_array(&source) {
                    let count = native_array_map_length(&source);
                    let offset = runtime::array_len(&result);
                    runtime::array_set_length(&result, offset + count);
                    for index in 0..count as usize {
                        match native_array_map_slot(&source, index as f64) {
                            Some(NativeValue::Undefined) => runtime::array_set_undefined(&result, offset + index as f64),
                            Some(value) => runtime::array_set(&result, offset + index as f64, value),
                            None => {}
                        }
                    }
                } else {
                    runtime::array_push(&result, source);
                }
            }
            NativeValue::Array(result)
        }
        _ => {
            let relative = match args.first() {
                None | Some(NativeValue::Undefined) => 0.0,
                Some(value) => {
                    let number = native_compare_number(value);
                    if number.is_nan() { 0.0 } else { number.trunc() }
                }
            };
            let index = if relative < 0.0 { length + relative } else { relative };
            if index < 0.0 || index >= length {
                return NativeValue::Undefined;
            }
            native_array_map_slot(&receiver, index).unwrap_or(NativeValue::Undefined)
        }
    }
}
