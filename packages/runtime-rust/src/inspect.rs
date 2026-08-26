struct InspectFrame {
    entries: Vec<(JsString, bool)>,
}

std::thread_local! {
    static INSPECT_FRAMES: RefCell<Vec<InspectFrame>> = const { RefCell::new(Vec::new()) };
    static INSPECT_CURRENT_DEPTH: Cell<f64> = const { Cell::new(0.0) };
}

fn inspect_utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub fn inspect_number(value: f64) -> JsString {
    if value == 0.0 && value.is_sign_negative() {
        string("-0")
    } else {
        string(&format_number(value))
    }
}

fn inspect_quote(value: &str) -> String {
    let quote = if !value.contains('\'') {
        '\''
    } else if !value.contains('"') {
        '"'
    } else if !value.contains('`') && !value.contains("${") {
        '`'
    } else {
        '\''
    };
    let mut output = String::with_capacity(value.len() + 2);
    output.push(quote);
    for character in value.chars() {
        match character {
            '\\' => output.push_str("\\\\"),
            '\'' if quote == '\'' => output.push_str("\\'"),
            '"' if quote == '"' => output.push_str("\\\""),
            '`' if quote == '`' => output.push_str("\\`"),
            '\u{0008}' => output.push_str("\\b"),
            '\t' => output.push_str("\\t"),
            '\n' => output.push_str("\\n"),
            '\u{000b}' => output.push_str("\\x0B"),
            '\u{000c}' => output.push_str("\\f"),
            '\r' => output.push_str("\\r"),
            character
                if (character as u32) < 0x20 || (0x7f..=0x9f).contains(&(character as u32)) =>
            {
                output.push_str(&format!("\\x{:02X}", character as u32));
            }
            character => output.push(character),
        }
    }
    output.push(quote);
    output
}

pub fn inspect_string(value: &JsString) -> JsString {
    let total_units = inspect_utf16_len(value);
    let (visible, visible_units, trailer) = if total_units > 10_000 {
        let mut units = 0usize;
        let mut end = 0usize;
        for (offset, character) in value.char_indices() {
            let width = character.len_utf16();
            if units + width > 10_000 {
                break;
            }
            units += width;
            end = offset + character.len_utf8();
        }
        let remaining = total_units - 10_000;
        (
            &value[..end],
            10_000,
            format!(
                "... {remaining} more character{}",
                if remaining == 1 { "" } else { "s" }
            ),
        )
    } else {
        (value.as_ref(), total_units, String::new())
    };
    let indentation = INSPECT_FRAMES.with(|frames| frames.borrow().len() * 2);
    let should_split = visible_units > 16
        && visible_units > 80usize.saturating_sub(indentation + 4)
        && visible.contains('\n');
    let mut output = if should_split {
        visible
            .split_inclusive('\n')
            .map(inspect_quote)
            .collect::<Vec<_>>()
            .join(&format!(" +\n{}", " ".repeat(indentation + 2)))
    } else {
        inspect_quote(visible)
    };
    output.push_str(&trailer);
    string(&output)
}

pub fn inspect_begin(recurse: f64) {
    INSPECT_CURRENT_DEPTH.with(|depth| depth.set(recurse));
    INSPECT_FRAMES.with(|frames| {
        frames.borrow_mut().push(InspectFrame {
            entries: Vec::new(),
        });
    });
}

pub fn inspect_entry(value: &JsString, is_number: bool) {
    INSPECT_FRAMES.with(|frames| {
        frames
            .borrow_mut()
            .last_mut()
            .expect("scriptc: inspect entry without a frame")
            .entries
            .push((value.clone(), is_number));
    });
}

pub fn inspect_more_items(remaining: f64) -> JsString {
    let count = to_uint32(remaining) as usize;
    string(&format!(
        "... {count} more item{}",
        if count == 1 { "" } else { "s" }
    ))
}

pub fn inspect_end(
    base: &JsString,
    open: &JsString,
    close: &JsString,
    recurse: f64,
    _array_extras: bool,
    _trailing_more: bool,
) -> JsString {
    let frame = INSPECT_FRAMES.with(|frames| {
        frames
            .borrow_mut()
            .pop()
            .expect("scriptc: inspect end without a frame")
    });
    let indent = ((recurse - 1.0).max(0.0) as usize) * 2;
    let below_break_length = INSPECT_CURRENT_DEPTH.with(|current_depth| {
        let start =
            frame.entries.len() + indent + inspect_utf16_len(open) + inspect_utf16_len(base) + 10;
        let total = frame.entries.len()
            + start
            + frame
                .entries
                .iter()
                .map(|(entry, _)| inspect_utf16_len(entry))
                .sum::<usize>();
        current_depth.get() - recurse < 3.0
            && total <= 80
            && !base.contains('\n')
            && frame.entries.iter().all(|(entry, _)| !entry.contains('\n'))
    });
    let mut output = String::new();
    if !base.is_empty() {
        output.push_str(base);
        output.push(' ');
    }
    output.push_str(open);
    if below_break_length {
        output.push(' ');
        for (index, (entry, _)) in frame.entries.iter().enumerate() {
            if index > 0 {
                output.push_str(", ");
            }
            output.push_str(entry);
        }
        output.push(' ');
    } else {
        for (index, (entry, _)) in frame.entries.iter().enumerate() {
            output.push_str(if index == 0 { "\n" } else { ",\n" });
            output.push_str(&" ".repeat(indent + 2));
            output.push_str(entry);
        }
        output.push('\n');
        output.push_str(&" ".repeat(indent));
    }
    output.push_str(close);
    string(&output)
}
