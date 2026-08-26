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

fn inspect_full_width(character: char) -> bool {
    let code = character as u32;
    code >= 0x1100
        && (code <= 0x115f
            || code == 0x2329
            || code == 0x232a
            || (0x2e80..=0x3247).contains(&code) && code != 0x303f
            || (0x3250..=0x4dbf).contains(&code)
            || (0x4e00..=0xa4c6).contains(&code)
            || (0xa960..=0xa97c).contains(&code)
            || (0xac00..=0xd7a3).contains(&code)
            || (0xf900..=0xfaff).contains(&code)
            || (0xfe10..=0xfe19).contains(&code)
            || (0xfe30..=0xfe6b).contains(&code)
            || (0xff01..=0xff60).contains(&code)
            || (0xffe0..=0xffe6).contains(&code)
            || (0x1b000..=0x1b001).contains(&code)
            || (0x1f200..=0x1f251).contains(&code)
            || (0x1f300..=0x1f64f).contains(&code)
            || (0x20000..=0x3fffd).contains(&code))
}

fn inspect_zero_width(character: char) -> bool {
    let code = character as u32;
    code <= 0x1f
        || (0x7f..=0x9f).contains(&code)
        || (0x300..=0x36f).contains(&code)
        || (0x200b..=0x200f).contains(&code)
        || (0x20d0..=0x20ff).contains(&code)
        || (0xfe00..=0xfe0f).contains(&code)
        || (0xfe20..=0xfe2f).contains(&code)
        || (0xe0100..=0xe01ef).contains(&code)
}

fn inspect_width(value: &str) -> usize {
    value
        .chars()
        .map(|character| {
            if inspect_full_width(character) {
                2
            } else if inspect_zero_width(character) {
                0
            } else {
                1
            }
        })
        .sum()
}

fn inspect_group(frame: &mut InspectFrame, trailing_more: bool, indent: usize) {
    let output_len = frame.entries.len() - usize::from(trailing_more);
    let widths: Vec<usize> = frame
        .entries
        .iter()
        .take(output_len)
        .map(|(entry, _)| inspect_width(entry))
        .collect();
    let total_length: usize = widths.iter().map(|width| width + 2).sum();
    let max_length = widths.iter().copied().max().unwrap_or(0);
    let actual_max = (max_length + 2) as f64;
    if actual_max * 3.0 + indent as f64 >= 80.0
        || !((total_length as f64 / actual_max) > 5.0 || max_length <= 6)
    {
        return;
    }
    let average_bias = (actual_max - total_length as f64 / frame.entries.len() as f64).sqrt();
    let biased_max = (actual_max - 3.0 - average_bias).max(1.0);
    let columns = ((2.5 * biased_max * output_len as f64).sqrt() / biased_max)
        .round()
        .min((80usize.saturating_sub(indent) as f64 / actual_max).floor())
        .min(12.0) as usize;
    if columns <= 1 {
        return;
    }
    let column_widths: Vec<usize> = (0..columns)
        .map(|column| {
            (column..output_len)
                .step_by(columns)
                .map(|index| widths[index])
                .max()
                .unwrap_or(0)
                + 2
        })
        .collect();
    let pad_start = frame.entries.iter().all(|(_, is_number)| *is_number);
    let mut grouped = Vec::new();
    for start in (0..output_len).step_by(columns) {
        let end = (start + columns).min(output_len);
        let mut line = String::new();
        for index in start..end {
            let width = widths[index];
            let last = index + 1 == end;
            if pad_start {
                let target = column_widths[index - start] - if last { 2 } else { 0 };
                line.push_str(&" ".repeat(target.saturating_sub(width + if last { 0 } else { 2 })));
            }
            line.push_str(&frame.entries[index].0);
            if !last {
                line.push_str(", ");
                if !pad_start {
                    line.push_str(
                        &" ".repeat(column_widths[index - start].saturating_sub(width + 2)),
                    );
                }
            }
        }
        grouped.push((string(&line), false));
    }
    if trailing_more {
        grouped.push(
            frame
                .entries
                .last()
                .expect("scriptc: missing inspect tail")
                .clone(),
        );
    }
    frame.entries = grouped;
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

pub fn inspect_regex(regex: &JsRegex) -> JsString {
    string(&format!(
        "/{}/{}",
        regex_source(regex).as_ref(),
        regex_flags(regex).as_ref()
    ))
}

pub fn inspect_buffer(bytes: &JsBytes<u8>) -> JsString {
    let length = bytes_len(bytes) as usize;
    let shown = length.min(50);
    let mut output = String::from("<Buffer ");
    for index in 0..shown {
        if index > 0 {
            output.push(' ');
        }
        output.push_str(&format!("{:02x}", bytes_get(bytes, index as f64) as u8));
    }
    if length > shown {
        let remaining = length - shown;
        output.push_str(&format!(
            " ... {remaining} more byte{}",
            if remaining == 1 { "" } else { "s" }
        ));
    }
    output.push('>');
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
    array_extras: bool,
    trailing_more: bool,
) -> JsString {
    let mut frame = INSPECT_FRAMES.with(|frames| {
        frames
            .borrow_mut()
            .pop()
            .expect("scriptc: inspect end without a frame")
    });
    let indent = ((recurse - 1.0).max(0.0) as usize) * 2;
    let original_entries = frame.entries.len();
    if array_extras && original_entries > 6 {
        inspect_group(&mut frame, trailing_more, indent);
    }
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
            && original_entries == frame.entries.len()
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
