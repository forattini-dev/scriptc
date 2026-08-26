#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ParseArgsKind {
    Undefined,
    Null,
    Number,
    Boolean,
    String,
    Array,
    Object,
    Other,
}

pub trait ParseArgsValue: HeapValue + ArrayElement + Clone {
    fn parse_args_kind(&self) -> ParseArgsKind;
    fn parse_args_bool(&self) -> Option<bool>;
    fn parse_args_number(&self) -> Option<f64>;
    fn parse_args_string(&self) -> Option<JsString>;
    fn parse_args_array_len(&self) -> Option<usize>;
    fn parse_args_array_get(&self, index: usize) -> Option<Self>;
    fn parse_args_array_push(&self, value: Self);
    fn parse_args_object_entries(&self) -> Option<Vec<(JsString, Self)>>;
    fn parse_args_object_set(&self, key: JsString, value: Self);
    fn parse_args_undefined() -> Self;
    fn parse_args_number_value(value: f64) -> Self;
    fn parse_args_bool_value(value: bool) -> Self;
    fn parse_args_string_value(value: JsString) -> Self;
    fn parse_args_array_value() -> Self;
    fn parse_args_object_value() -> Self;
    fn parse_args_specific_type(&self) -> String;
    fn parse_args_inspect_lite(&self) -> String;
    fn parse_args_display(&self) -> String;
}

fn pa_own_member<T: ParseArgsValue>(object: &T, key: &str) -> Option<T> {
    object
        .parse_args_object_entries()?
        .into_iter()
        .find_map(|(name, value)| (name.as_ref() == key).then_some(value))
}

fn pa_member<T: ParseArgsValue>(object: &T, key: &str) -> Option<T> {
    pa_own_member(object, key)
        .filter(|value| value.parse_args_kind() != ParseArgsKind::Undefined)
}

fn pa_throw_type<T: ParseArgsValue>(name: &str, expected: &str, value: &T, property: bool) -> ! {
    let noun = if property { "property" } else { "argument" };
    throw_type_error_code(
        format!(
            "The \"{name}\" {noun} must be {expected}. Received {}",
            value.parse_args_specific_type(),
        ),
        "ERR_INVALID_ARG_TYPE",
    )
}

fn pa_throw_value<T: ParseArgsValue>(name: &str, reason: &str, value: &T) -> ! {
    let noun = if name.contains('.') { "property" } else { "argument" };
    throw_type_error_code(
        format!(
            "The {noun} '{name}' {reason}. Received {}",
            value.parse_args_inspect_lite(),
        ),
        "ERR_INVALID_ARG_VALUE",
    )
}

fn pa_unknown(raw: &str, allow_positionals: bool) -> ! {
    let hint = if allow_positionals {
        format!(
            ". To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{raw}\"",
        )
    } else {
        String::new()
    };
    throw_type_error_code(
        format!("Unknown option '{raw}'{hint}"),
        "ERR_PARSE_ARGS_UNKNOWN_OPTION",
    )
}

fn pa_option_label<T: ParseArgsValue>(desc: &T, name: &str) -> String {
    match pa_member(desc, "short").and_then(|value| value.parse_args_string()) {
        Some(short) if !short.is_empty() => format!("-{short}, --{name}"),
        _ => format!("--{name}"),
    }
}

fn pa_missing_value<T: ParseArgsValue>(desc: &T, name: &str) -> ! {
    throw_type_error_code(
        format!("Option '{} <value>' argument missing", pa_option_label(desc, name)),
        "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
    )
}

fn pa_ambiguous(raw: &str, name: &str, is_short: bool) -> ! {
    let short_hint = if is_short {
        format!(" or '{raw}-XYZ'")
    } else {
        String::new()
    };
    throw_type_error_code(
        format!(
            "Option '{raw}' argument is ambiguous.\nDid you forget to specify the option argument for '{raw}'?\nTo specify an option argument starting with a dash use '--{name}=-XYZ'{short_hint}.",
        ),
        "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
    )
}

fn pa_takes_no_value<T: ParseArgsValue>(desc: &T, name: &str) -> ! {
    throw_type_error_code(
        format!("Option '{}' does not take an argument", pa_option_label(desc, name)),
        "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
    )
}

fn pa_unexpected<T: ParseArgsValue>(value: &T) -> ! {
    let shown = value
        .parse_args_string()
        .map_or_else(|| value.parse_args_display(), |value| value.to_string());
    throw_type_error_code(
        format!("Unexpected argument '{shown}'. This command does not take positional arguments"),
        "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
    )
}

fn pa_config_bool<T: ParseArgsValue>(config: &T, name: &str, fallback: bool) -> bool {
    let Some(value) = pa_member(config, name) else {
        return fallback;
    };
    if value.parse_args_kind() == ParseArgsKind::Null {
        return fallback;
    }
    value
        .parse_args_bool()
        .unwrap_or_else(|| pa_throw_type(name, "of type boolean", &value, false))
}

fn pa_desc_type<T: ParseArgsValue>(desc: &T) -> Option<bool> {
    match pa_member(desc, "type").and_then(|value| value.parse_args_string()) {
        Some(value) if value.as_ref() == "string" => Some(true),
        Some(value) if value.as_ref() == "boolean" => Some(false),
        _ => None,
    }
}

fn pa_desc_multiple<T: ParseArgsValue>(desc: &T) -> bool {
    pa_member(desc, "multiple")
        .and_then(|value| value.parse_args_bool())
        .unwrap_or(false)
}

fn pa_default_value_ok<T: ParseArgsValue>(value: &T, string_type: bool) -> bool {
    value.parse_args_kind()
        == if string_type {
            ParseArgsKind::String
        } else {
            ParseArgsKind::Boolean
        }
}

fn pa_validate_option<T: ParseArgsValue>(name: &str, desc: &T) {
    let base = format!("options.{name}");
    if desc.parse_args_kind() != ParseArgsKind::Object {
        pa_throw_type(&base, "of type object", desc, true);
    }
    let string_type = pa_desc_type(desc).unwrap_or_else(|| {
        let value = pa_member(desc, "type").unwrap_or_else(T::parse_args_undefined);
        pa_throw_type(&format!("{base}.type"), "('string|boolean')", &value, true)
    });
    if let Some(short) = pa_own_member(desc, "short") {
        let Some(value) = short.parse_args_string() else {
            pa_throw_type(&format!("{base}.short"), "of type string", &short, true)
        };
        if string_len(&value) != 1.0 {
            pa_throw_value(
                &format!("{base}.short"),
                "must be a single character",
                &short,
            );
        }
    }
    if let Some(multiple) = pa_own_member(desc, "multiple")
        && multiple.parse_args_kind() != ParseArgsKind::Boolean
    {
        pa_throw_type(
            &format!("{base}.multiple"),
            "of type boolean",
            &multiple,
            true,
        );
    }
    if let Some(default) = pa_member(desc, "default") {
        if pa_desc_multiple(desc) {
            let Some(length) = default.parse_args_array_len() else {
                pa_throw_type(
                    &format!("{base}.default"),
                    "an instance of Array",
                    &default,
                    true,
                )
            };
            for index in 0..length {
                let item = default
                    .parse_args_array_get(index)
                    .expect("scriptc: parseArgs default array changed length");
                if !pa_default_value_ok(&item, string_type) {
                    pa_throw_type(
                        &format!("{base}.default[{index}]"),
                        if string_type {
                            "of type string"
                        } else {
                            "of type boolean"
                        },
                        &item,
                        true,
                    );
                }
            }
        } else if !pa_default_value_ok(&default, string_type) {
            pa_throw_type(
                &format!("{base}.default"),
                if string_type {
                    "of type string"
                } else {
                    "of type boolean"
                },
                &default,
                true,
            );
        }
    }
}

fn pa_validate_options<T: ParseArgsValue>(options: Option<&T>) {
    let Some(options) = options else { return };
    let Some(entries) = options.parse_args_object_entries() else {
        pa_throw_type("options", "of type object", options, false)
    };
    for (name, desc) in entries {
        pa_validate_option(name.as_ref(), &desc);
    }
}

fn pa_find_long<T: ParseArgsValue>(options: Option<&T>, name: &str) -> Option<T> {
    options.and_then(|options| pa_own_member(options, name))
}

fn pa_find_short<T: ParseArgsValue>(options: Option<&T>, short: &str) -> (String, Option<T>) {
    if let Some(options) = options {
        for (name, desc) in options.parse_args_object_entries().unwrap_or_default() {
            if pa_member(&desc, "short")
                .and_then(|value| value.parse_args_string())
                .is_some_and(|value| value.as_ref() == short)
            {
                let name = name.to_string();
                return (name.clone(), pa_find_long(Some(options), &name));
            }
        }
    }
    (short.to_owned(), pa_find_long(options, short))
}

fn pa_negative_name(name: &str) -> Option<&str> {
    name.strip_prefix("no-")
}

fn pa_long_eq(argument: &str) -> Option<usize> {
    let bytes = argument.as_bytes();
    if !bytes.iter().skip(3).any(|byte| *byte == b'=') {
        return None;
    }
    bytes.iter().skip(2).position(|byte| *byte == b'=').map(|at| at + 2)
}

fn pa_option_token<T: ParseArgsValue>(
    name: &str,
    raw: &str,
    index: usize,
    value: Option<T>,
    inline: Option<bool>,
) -> T {
    let token = T::parse_args_object_value();
    token.parse_args_object_set(
        string("kind"),
        T::parse_args_string_value(string("option")),
    );
    token.parse_args_object_set(
        string("name"),
        T::parse_args_string_value(string(name)),
    );
    token.parse_args_object_set(
        string("rawName"),
        T::parse_args_string_value(string(raw)),
    );
    token.parse_args_object_set(
        string("index"),
        T::parse_args_number_value(index as f64),
    );
    token.parse_args_object_set(
        string("value"),
        value.unwrap_or_else(T::parse_args_undefined),
    );
    token.parse_args_object_set(
        string("inlineValue"),
        inline
            .map(T::parse_args_bool_value)
            .unwrap_or_else(T::parse_args_undefined),
    );
    token
}

#[allow(clippy::too_many_arguments)]
fn pa_store<T: ParseArgsValue>(
    values: &T,
    tokens: Option<&T>,
    desc: Option<&T>,
    name: &str,
    raw: &str,
    index: usize,
    value: Option<T>,
    flag_value: bool,
    inline: Option<bool>,
    withhold_proto: bool,
) {
    if withhold_proto && name == "__proto__" {
        if let Some(tokens) = tokens {
            tokens.parse_args_array_push(pa_option_token(name, raw, index, value, inline));
        }
        return;
    }
    let stored = value
        .clone()
        .unwrap_or_else(|| T::parse_args_bool_value(flag_value));
    if desc.is_some_and(pa_desc_multiple) {
        let array = pa_own_member(values, name).unwrap_or_else(|| {
            let array = T::parse_args_array_value();
            values.parse_args_object_set(string(name), array.clone());
            array
        });
        array.parse_args_array_push(stored);
    } else {
        values.parse_args_object_set(string(name), stored);
    }
    if let Some(tokens) = tokens {
        tokens.parse_args_array_push(pa_option_token(name, raw, index, value, inline));
    }
}

#[allow(clippy::too_many_arguments)]
fn pa_store_flag<T: ParseArgsValue>(
    values: &T,
    tokens: Option<&T>,
    options: Option<&T>,
    desc: Option<&T>,
    name: &str,
    raw: &str,
    index: usize,
    allow_negative: bool,
) {
    if allow_negative && let Some(positive) = pa_negative_name(name) {
        let positive_desc = pa_find_long(options, positive);
        pa_store(
            values,
            tokens,
            positive_desc.as_ref(),
            positive,
            raw,
            index,
            None,
            false,
            None,
            false,
        );
    } else {
        pa_store(
            values,
            tokens,
            desc,
            name,
            raw,
            index,
            None,
            true,
            None,
            true,
        );
    }
}

fn pa_positional<T: ParseArgsValue>(positionals: &T, tokens: Option<&T>, value: T, index: usize) {
    positionals.parse_args_array_push(value.clone());
    let Some(tokens) = tokens else { return };
    let token = T::parse_args_object_value();
    token.parse_args_object_set(
        string("kind"),
        T::parse_args_string_value(string("positional")),
    );
    token.parse_args_object_set(
        string("index"),
        T::parse_args_number_value(index as f64),
    );
    token.parse_args_object_set(string("value"), value);
    tokens.parse_args_array_push(token);
}

fn pa_default_args<T: ParseArgsValue>() -> T {
    let output = T::parse_args_array_value();
    let argv = process_argv();
    let mut index = 2.0;
    while index < array_len(&argv) {
        output.parse_args_array_push(T::parse_args_string_value(array_get(&argv, index)));
        index += 1.0;
    }
    output
}

fn pa_consumes_next<T: ParseArgsValue>(options: Option<&T>, argument: &JsString) -> bool {
    if let Some(rest) = argument.strip_prefix("--") {
        let name = pa_long_eq(argument)
            .map_or(rest, |equals| &argument[2..equals]);
        return pa_long_eq(argument).is_none()
            && pa_find_long(options, name)
                .as_ref()
                .and_then(pa_desc_type)
                == Some(true);
    }
    if argument.len() <= 1 || !argument.starts_with('-') {
        return false;
    }
    let units = string_len(argument) as usize;
    for at in 1..units {
        let short = string_char_at(argument, at as f64);
        let (_, desc) = pa_find_short(options, short.as_ref());
        if desc.as_ref().and_then(pa_desc_type) == Some(true) {
            return at + 1 >= units;
        }
    }
    false
}

pub fn util_parse_args<T: ParseArgsValue>(config: T) -> T {
    if config.parse_args_kind() == ParseArgsKind::Null {
        throw_type_error("Cannot convert undefined or null to object".to_owned());
    }
    let config_is_object = config.parse_args_kind() == ParseArgsKind::Object;
    let member = |name: &str| config_is_object.then(|| pa_member(&config, name)).flatten();
    let args = match member("args") {
        None => pa_default_args(),
        Some(value) if value.parse_args_kind() == ParseArgsKind::Null => pa_default_args(),
        Some(value) if value.parse_args_kind() == ParseArgsKind::Array => value,
        Some(value) => pa_throw_type("args", "an instance of Array", &value, false),
    };
    let strict = pa_config_bool(&config, "strict", true);
    let allow_positionals = pa_config_bool(&config, "allowPositionals", !strict);
    let return_tokens = pa_config_bool(&config, "tokens", false);
    let allow_negative = pa_config_bool(&config, "allowNegative", false);
    let options = member("options").filter(|value| value.parse_args_kind() != ParseArgsKind::Null);
    pa_validate_options(options.as_ref());

    let length = args
        .parse_args_array_len()
        .expect("scriptc: parseArgs args changed kind");
    let mut scan_after_terminator = false;
    let mut index = 0;
    while index < length {
        let argument = args
            .parse_args_array_get(index)
            .expect("scriptc: parseArgs args changed length");
        if scan_after_terminator {
            index += 1;
            continue;
        }
        if matches!(
            argument.parse_args_kind(),
            ParseArgsKind::Undefined | ParseArgsKind::Null
        ) {
            let kind = if argument.parse_args_kind() == ParseArgsKind::Null {
                "null"
            } else {
                "undefined"
            };
            throw_type_error(format!(
                "Cannot read properties of {kind} (reading 'length')"
            ));
        }
        if let Some(text) = argument.parse_args_string() {
            if text.as_ref() == "--" {
                scan_after_terminator = true;
            } else if pa_consumes_next(options.as_ref(), &text)
                && index + 1 < length
                && args
                    .parse_args_array_get(index + 1)
                    .is_some_and(|next| {
                        !matches!(
                            next.parse_args_kind(),
                            ParseArgsKind::Undefined | ParseArgsKind::Null
                        )
                    })
            {
                index += 1;
            }
        }
        index += 1;
    }

    let result = T::parse_args_object_value();
    let values = T::parse_args_object_value();
    let positionals = T::parse_args_array_value();
    let tokens = return_tokens.then(T::parse_args_array_value);
    let mut after_terminator = false;
    let mut index = 0;
    while index < length {
        let argument = args
            .parse_args_array_get(index)
            .expect("scriptc: parseArgs args changed length");
        if after_terminator {
            if !allow_positionals {
                pa_unexpected(&argument);
            }
            pa_positional(&positionals, tokens.as_ref(), argument, index);
            index += 1;
            continue;
        }
        if matches!(
            argument.parse_args_kind(),
            ParseArgsKind::Undefined | ParseArgsKind::Null
        ) {
            let kind = if argument.parse_args_kind() == ParseArgsKind::Null {
                "null"
            } else {
                "undefined"
            };
            throw_type_error(format!(
                "Cannot read properties of {kind} (reading 'length')"
            ));
        }
        let Some(text) = argument.parse_args_string() else {
            if !allow_positionals {
                pa_unexpected(&argument);
            }
            pa_positional(&positionals, tokens.as_ref(), argument, index);
            index += 1;
            continue;
        };
        if text.as_ref() == "--" {
            after_terminator = true;
            if let Some(tokens) = &tokens {
                let token = T::parse_args_object_value();
                token.parse_args_object_set(
                    string("kind"),
                    T::parse_args_string_value(string("option-terminator")),
                );
                token.parse_args_object_set(
                    string("index"),
                    T::parse_args_number_value(index as f64),
                );
                tokens.parse_args_array_push(token);
            }
            index += 1;
            continue;
        }

        if text.starts_with("--") {
            let equals = pa_long_eq(&text);
            let split = equals.unwrap_or(text.len());
            let name = &text[2..split];
            let raw = &text[..split];
            let desc = pa_find_long(options.as_ref(), name);
            if let Some(equals) = equals {
                let mut checked_name = name;
                let mut checked_desc = desc.clone();
                if strict && checked_desc.is_none() && allow_negative
                    && let Some(positive) = pa_negative_name(name)
                {
                    let positive_desc = pa_find_long(options.as_ref(), positive);
                    if positive_desc.as_ref().and_then(pa_desc_type) == Some(false) {
                        checked_name = positive;
                        checked_desc = positive_desc;
                    }
                }
                if strict && checked_desc.is_none() {
                    pa_unknown(raw, allow_positionals);
                }
                if strict && checked_desc.as_ref().and_then(pa_desc_type) == Some(false) {
                    pa_takes_no_value(checked_desc.as_ref().unwrap(), checked_name);
                }
                let value = T::parse_args_string_value(string(&text[equals + 1..]));
                pa_store(
                    &values,
                    tokens.as_ref(),
                    desc.as_ref(),
                    name,
                    raw,
                    index,
                    Some(value),
                    true,
                    Some(true),
                    true,
                );
            } else if desc.as_ref().and_then(pa_desc_type) == Some(true) {
                let next = (index + 1 < length)
                    .then(|| args.parse_args_array_get(index + 1))
                    .flatten()
                    .filter(|value| {
                        !matches!(
                            value.parse_args_kind(),
                            ParseArgsKind::Undefined | ParseArgsKind::Null
                        )
                    });
                if let Some(next) = next {
                    index += 1;
                    if strict && next.parse_args_kind() != ParseArgsKind::String {
                        pa_missing_value(desc.as_ref().unwrap(), name);
                    }
                    if strict
                        && next
                            .parse_args_string()
                            .is_some_and(|value| value.len() > 1 && value.starts_with('-'))
                    {
                        pa_ambiguous(raw, name, false);
                    }
                    pa_store(
                        &values,
                        tokens.as_ref(),
                        desc.as_ref(),
                        name,
                        raw,
                        index - 1,
                        Some(next),
                        true,
                        Some(false),
                        true,
                    );
                } else if strict {
                    pa_missing_value(desc.as_ref().unwrap(), name);
                } else {
                    pa_store_flag(
                        &values,
                        tokens.as_ref(),
                        options.as_ref(),
                        desc.as_ref(),
                        name,
                        raw,
                        index,
                        allow_negative,
                    );
                }
            } else {
                let positive = allow_negative.then(|| pa_negative_name(name)).flatten();
                let positive_desc = positive.and_then(|name| pa_find_long(options.as_ref(), name));
                if strict
                    && desc.is_none()
                    && (positive.is_none()
                        || positive_desc.as_ref().and_then(pa_desc_type) != Some(false))
                {
                    pa_unknown(raw, allow_positionals);
                }
                if let Some(positive) = positive {
                    pa_store(
                        &values,
                        tokens.as_ref(),
                        positive_desc.as_ref(),
                        positive,
                        raw,
                        index,
                        None,
                        false,
                        None,
                        false,
                    );
                } else {
                    pa_store(
                        &values,
                        tokens.as_ref(),
                        desc.as_ref(),
                        name,
                        raw,
                        index,
                        None,
                        true,
                        None,
                        true,
                    );
                }
            }
            index += 1;
            continue;
        }

        if text.len() > 1 && text.starts_with('-') {
            let units = string_len(&text) as usize;
            let mut at = 1;
            while at < units {
                let short = string_char_at(&text, at as f64);
                let (name, desc) = pa_find_short(options.as_ref(), short.as_ref());
                let raw = format!("-{short}");
                if strict && desc.is_none() {
                    pa_unknown(&raw, allow_positionals);
                }
                if desc.as_ref().and_then(pa_desc_type) == Some(true) {
                    if at + 1 < units {
                        let value = string_slice(&text, (at + 1) as f64, f64::INFINITY);
                        pa_store(
                            &values,
                            tokens.as_ref(),
                            desc.as_ref(),
                            &name,
                            &raw,
                            index,
                            Some(T::parse_args_string_value(value)),
                            true,
                            Some(true),
                            true,
                        );
                        break;
                    } else if index + 1 < length {
                        let value = args
                            .parse_args_array_get(index + 1)
                            .expect("scriptc: parseArgs args changed length");
                        if !matches!(
                            value.parse_args_kind(),
                            ParseArgsKind::Undefined | ParseArgsKind::Null
                        ) {
                            index += 1;
                            if strict && value.parse_args_kind() != ParseArgsKind::String {
                                pa_missing_value(desc.as_ref().unwrap(), &name);
                            }
                            if strict
                                && value
                                    .parse_args_string()
                                    .is_some_and(|value| value.len() > 1 && value.starts_with('-'))
                            {
                                pa_ambiguous(&raw, &name, true);
                            }
                            pa_store(
                                &values,
                                tokens.as_ref(),
                                desc.as_ref(),
                                &name,
                                &raw,
                                index - 1,
                                Some(value),
                                true,
                                Some(false),
                                true,
                            );
                            break;
                        }
                    }
                    if strict {
                        pa_missing_value(desc.as_ref().unwrap(), &name);
                    }
                    pa_store_flag(
                        &values,
                        tokens.as_ref(),
                        options.as_ref(),
                        desc.as_ref(),
                        &name,
                        &raw,
                        index,
                        allow_negative,
                    );
                    break;
                }
                pa_store_flag(
                    &values,
                    tokens.as_ref(),
                    options.as_ref(),
                    desc.as_ref(),
                    &name,
                    &raw,
                    index,
                    allow_negative,
                );
                at += 1;
            }
            index += 1;
            continue;
        }

        if !allow_positionals {
            pa_unexpected(&argument);
        }
        pa_positional(&positionals, tokens.as_ref(), argument, index);
        index += 1;
    }

    if let Some(options) = &options {
        for (name, desc) in options.parse_args_object_entries().unwrap_or_default() {
            if name.as_ref() == "__proto__" || pa_own_member(&values, name.as_ref()).is_some() {
                continue;
            }
            if let Some(default) = pa_member(&desc, "default") {
                values.parse_args_object_set(name, default);
            }
        }
    }
    result.parse_args_object_set(string("values"), values);
    result.parse_args_object_set(string("positionals"), positionals);
    if let Some(tokens) = tokens {
        result.parse_args_object_set(string("tokens"), tokens);
    }
    result
}
