// Node 24's legacy-codec tables are generated into a compact binary asset;
// this file keeps the decoding state machines readable and platform-neutral.
const TEXT_DECODER_DATA: &[u8] = include_bytes!("../data/text-decoder.bin");

const TD_SINGLE_COUNT: usize = 27;
const TD_GB18030: usize = TD_SINGLE_COUNT * 128;
const TD_BIG5: usize = TD_GB18030 + 126 * 190;
const TD_JIS0208: usize = TD_BIG5 + 126 * 157;
const TD_JIS0212: usize = TD_JIS0208 + 94 * 94;
const TD_SHIFT_JIS: usize = TD_JIS0212 + 94 * 94;
const TD_EUC_KR: usize = TD_SHIFT_JIS + 60 * 188;
const TD_TABLE_END: usize = TD_EUC_KR + 94 * 94;

fn td_input(bytes: &JsBytes<u8>) -> Vec<u8> {
    bytes.with(|data| {
        let storage = data.storage.borrow();
        storage[data.offset..data.offset + data.length].to_vec()
    })
}

fn td_table(offset: usize, index: usize) -> u32 {
    let byte = (offset + index) * 2;
    u32::from(u16::from_le_bytes([
        TEXT_DECODER_DATA[byte],
        TEXT_DECODER_DATA[byte + 1],
    ]))
}

fn td_u32(offset: usize) -> u32 {
    u32::from_le_bytes(
        TEXT_DECODER_DATA[offset..offset + 4]
            .try_into()
            .expect("scriptc: truncated TextDecoder oracle"),
    )
}

fn td_gb_range(pointer: u32) -> u32 {
    let base = TD_TABLE_END * 2;
    let mut low = 0;
    let mut high = (TEXT_DECODER_DATA.len() - base) / 12;
    while low < high {
        let middle = low + (high - low) / 2;
        let offset = base + middle * 12;
        let start = td_u32(offset);
        let end = td_u32(offset + 4);
        if pointer < start {
            high = middle;
        } else if pointer > end {
            low = middle + 1;
        } else {
            return td_u32(offset + 8) + pointer - start;
        }
    }
    0
}

fn td_put(output: &mut String, code_point: u32) {
    output.push(char::from_u32(code_point).unwrap_or(char::REPLACEMENT_CHARACTER));
}

fn td_error(output: &mut String) {
    output.push(char::REPLACEMENT_CHARACTER);
}

pub fn text_decode(bytes: &JsBytes<u8>) -> JsString {
    let input = td_input(bytes);
    let input = input.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&input);
    Rc::from(String::from_utf8_lossy(input).as_ref())
}

fn td_single_byte(input: &[u8], encoding: usize) -> JsString {
    let mut output = String::with_capacity(input.len());
    for byte in input {
        td_put(
            &mut output,
            if *byte < 0x80 {
                u32::from(*byte)
            } else {
                td_table(encoding * 128, usize::from(*byte - 0x80))
            },
        );
    }
    Rc::from(output)
}

fn td_x_user_defined(input: &[u8]) -> JsString {
    Rc::from(
        input
            .iter()
            .map(|byte| {
                char::from_u32(if *byte < 0x80 {
                    u32::from(*byte)
                } else {
                    0xf780 + u32::from(*byte - 0x80)
                })
                .expect("scriptc: invalid x-user-defined code point")
            })
            .collect::<String>(),
    )
}

fn td_utf16(input: &[u8], big_endian: bool) -> JsString {
    let input = if input.len() >= 2
        && ((!big_endian && input[..2] == [0xff, 0xfe])
            || (big_endian && input[..2] == [0xfe, 0xff]))
    {
        &input[2..]
    } else {
        input
    };
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index + 1 < input.len() {
        let unit = if big_endian {
            u16::from_be_bytes([input[index], input[index + 1]])
        } else {
            u16::from_le_bytes([input[index], input[index + 1]])
        };
        index += 2;
        if (0xd800..=0xdbff).contains(&unit) {
            if index + 1 < input.len() {
                let low = if big_endian {
                    u16::from_be_bytes([input[index], input[index + 1]])
                } else {
                    u16::from_le_bytes([input[index], input[index + 1]])
                };
                if (0xdc00..=0xdfff).contains(&low) {
                    index += 2;
                    td_put(
                        &mut output,
                        0x10000
                            + ((u32::from(unit) - 0xd800) << 10)
                            + (u32::from(low) - 0xdc00),
                    );
                    continue;
                }
            } else if index < input.len() {
                index += 1;
            }
            td_error(&mut output);
        } else if (0xdc00..=0xdfff).contains(&unit) {
            td_error(&mut output);
        } else {
            td_put(&mut output, u32::from(unit));
        }
    }
    if index < input.len() {
        td_error(&mut output);
    }
    Rc::from(output)
}

fn td_gb18030(input: &[u8]) -> JsString {
    let mut output = String::with_capacity(input.len());
    let (mut first, mut second, mut third) = (0_u8, 0_u8, 0_u8);
    let mut replay = Vec::with_capacity(3);
    let mut index = 0;
    while index < input.len() || !replay.is_empty() {
        let byte = replay.pop().unwrap_or_else(|| {
            let byte = input[index];
            index += 1;
            byte
        });
        if third != 0 {
            let valid_fourth = (0x30..=0x39).contains(&byte);
            let code_point = if valid_fourth {
                let pointer = (((u32::from(first - 0x81) * 10 + u32::from(second - 0x30))
                    * 126
                    + u32::from(third - 0x81))
                    * 10)
                    + u32::from(byte - 0x30);
                td_gb_range(pointer)
            } else {
                0
            };
            let (old_second, old_third) = (second, third);
            (first, second, third) = (0, 0, 0);
            if code_point != 0 {
                td_put(&mut output, code_point);
            } else {
                td_error(&mut output);
                if !valid_fourth {
                    replay.extend([byte, old_third, old_second]);
                }
            }
        } else if second != 0 {
            if (0x81..=0xfe).contains(&byte) {
                third = byte;
            } else {
                let old_second = second;
                first = 0;
                second = 0;
                td_error(&mut output);
                replay.extend([byte, old_second]);
            }
        } else if first != 0 {
            if (0x30..=0x39).contains(&byte) {
                second = byte;
                continue;
            }
            let lead = first;
            first = 0;
            let valid_trail = (0x40..=0x7e).contains(&byte) || (0x80..=0xfe).contains(&byte);
            let code_point = if valid_trail {
                let offset = if byte < 0x7f { 0x40 } else { 0x41 };
                td_table(
                    TD_GB18030,
                    usize::from(lead - 0x81) * 190 + usize::from(byte - offset),
                )
            } else {
                0
            };
            if code_point != 0 {
                td_put(&mut output, code_point);
            } else {
                td_error(&mut output);
                if !valid_trail && byte < 0x80 {
                    replay.push(byte);
                }
            }
        } else if byte < 0x80 {
            td_put(&mut output, u32::from(byte));
        } else if byte == 0x80 {
            td_put(&mut output, 0x20ac);
        } else if (0x81..=0xfe).contains(&byte) {
            first = byte;
        } else {
            td_error(&mut output);
        }
    }
    if first != 0 || second != 0 || third != 0 {
        td_error(&mut output);
    }
    Rc::from(output)
}

fn td_big5(input: &[u8]) -> JsString {
    let mut output = String::with_capacity(input.len());
    let mut lead = 0;
    let mut index = 0;
    while index < input.len() {
        let byte = input[index];
        index += 1;
        if lead != 0 {
            let valid = (0x40..=0x7e).contains(&byte) || (0xa1..=0xfe).contains(&byte);
            let code_point = if valid {
                let offset = if byte < 0x7f { 0x40 } else { 0x62 };
                td_table(
                    TD_BIG5,
                    usize::from(lead - 0x81) * 157 + usize::from(byte - offset),
                )
            } else {
                0
            };
            lead = 0;
            if code_point != 0 {
                td_put(&mut output, code_point);
            } else {
                td_error(&mut output);
                if byte < 0x80 || byte == 0xff {
                    index -= 1;
                }
            }
        } else if byte <= 0x80 {
            td_put(&mut output, u32::from(byte));
        } else if (0x81..=0xfe).contains(&byte) {
            lead = byte;
        } else if byte == 0xff {
            td_put(&mut output, 0xf8f8);
        } else {
            td_error(&mut output);
        }
    }
    if lead != 0 {
        td_error(&mut output);
    }
    Rc::from(output)
}

fn td_euc_jp(input: &[u8]) -> JsString {
    let mut output = String::with_capacity(input.len());
    let mut lead = 0;
    let mut jis0212 = false;
    let mut index = 0;
    while index < input.len() {
        let byte = input[index];
        index += 1;
        if lead == 0x8e && (0xa1..=0xdf).contains(&byte) {
            lead = 0;
            td_put(&mut output, 0xff61 + u32::from(byte - 0xa1));
        } else if lead == 0x8e && (0xe0..=0xe2).contains(&byte) {
            lead = 0;
            td_put(&mut output, [0x00a2, 0x00a3, 0x00ac][usize::from(byte - 0xe0)]);
        } else if lead == 0x8f && (0xa1..=0xfe).contains(&byte) {
            jis0212 = true;
            lead = byte;
        } else if lead != 0 {
            let old_lead = lead;
            lead = 0;
            let valid = (0xa1..=0xfe).contains(&old_lead) && (0xa1..=0xfe).contains(&byte);
            let code_point = if valid {
                let pointer = usize::from(old_lead - 0xa1) * 94 + usize::from(byte - 0xa1);
                td_table(if jis0212 { TD_JIS0212 } else { TD_JIS0208 }, pointer)
            } else {
                0
            };
            if jis0212 && !valid {
                jis0212 = false;
                lead = old_lead;
                td_error(&mut output);
                index -= 1;
                continue;
            }
            jis0212 = false;
            if code_point != 0 {
                td_put(&mut output, code_point);
            } else {
                td_error(&mut output);
                if byte < 0xa0 || (old_lead == 0x8e && (0xe5..=0xfe).contains(&byte)) {
                    index -= 1;
                }
            }
        } else if byte < 0xa0 && byte != 0x8e && byte != 0x8f {
            td_put(&mut output, u32::from(byte));
        } else if byte == 0x8e || byte == 0x8f || (0xa1..=0xfe).contains(&byte) {
            lead = byte;
        } else {
            td_error(&mut output);
        }
    }
    if lead != 0 {
        td_error(&mut output);
    }
    Rc::from(output)
}

fn td_shift_jis(input: &[u8]) -> JsString {
    let mut output = String::with_capacity(input.len());
    let mut lead = 0;
    let mut index = 0;
    while index < input.len() {
        let byte = input[index];
        index += 1;
        if lead != 0 {
            let valid = (0x40..=0x7e).contains(&byte) || (0x80..=0xfc).contains(&byte);
            let code_point = if valid {
                let offset = if byte < 0x7f { 0x40 } else { 0x41 };
                let lead_offset = if lead < 0xa0 { 0x81 } else { 0xc1 };
                td_table(
                    TD_SHIFT_JIS,
                    usize::from(lead - lead_offset) * 188 + usize::from(byte - offset),
                )
            } else {
                0
            };
            lead = 0;
            if code_point != 0 {
                td_put(&mut output, code_point);
            } else {
                td_error(&mut output);
                if !valid {
                    index -= 1;
                }
            }
        } else if byte == 0x1a {
            td_put(&mut output, 0x1c);
        } else if byte == 0x1c {
            td_put(&mut output, 0x7f);
        } else if byte == 0x7f {
            td_put(&mut output, 0x1a);
        } else if byte < 0x80 {
            td_put(&mut output, u32::from(byte));
        } else if (0xa1..=0xdf).contains(&byte) {
            td_put(&mut output, 0xff61 + u32::from(byte - 0xa1));
        } else if (0x81..=0x9f).contains(&byte) || (0xe0..=0xfc).contains(&byte) {
            lead = byte;
        } else {
            td_error(&mut output);
        }
    }
    if lead != 0 {
        td_error(&mut output);
    }
    Rc::from(output)
}

fn td_euc_kr(input: &[u8]) -> JsString {
    let mut output = String::with_capacity(input.len());
    let mut lead = 0;
    let mut index = 0;
    while index < input.len() {
        let byte = input[index];
        index += 1;
        if lead != 0 {
            let code_point = if (0xa1..=0xfe).contains(&lead) && (0xa1..=0xfe).contains(&byte) {
                td_table(
                    TD_EUC_KR,
                    usize::from(lead - 0xa1) * 94 + usize::from(byte - 0xa1),
                )
            } else {
                0
            };
            lead = 0;
            if code_point != 0 {
                td_put(&mut output, code_point);
            } else {
                td_error(&mut output);
                if byte < 0xa0 {
                    index -= 1;
                }
            }
        } else if byte < 0xa0 && byte != 0x8e && byte != 0x8f {
            td_put(&mut output, u32::from(byte));
        } else if (0xa1..=0xfe).contains(&byte) {
            lead = byte;
        } else {
            td_error(&mut output);
        }
    }
    if lead != 0 {
        td_error(&mut output);
    }
    Rc::from(output)
}

#[derive(Clone, Copy, PartialEq)]
enum TdIsoState {
    Ascii,
    Roman,
    Katakana,
    Lead,
    Trail,
    EscapeStart,
    Escape,
}

fn td_iso_2022_jp(input: &[u8]) -> JsString {
    use TdIsoState::{Ascii, Escape, EscapeStart, Katakana, Lead, Roman, Trail};

    let mut output = String::with_capacity(input.len());
    let mut state = Ascii;
    let mut output_state = Ascii;
    let mut lead = 0;
    let mut replay = None;
    let mut output_flag = false;
    let mut index = 0;
    let mut at_eof = false;
    while !at_eof {
        let item = replay.take().or_else(|| {
            let item = input.get(index).copied();
            index += usize::from(item.is_some());
            item
        });
        let byte = item.unwrap_or(0);
        if item.is_some()
            && (byte == 0x0a || byte == 0x0d)
            && (state == Katakana || state == Lead)
        {
            output_flag = false;
            state = Ascii;
            output_state = Ascii;
            td_put(&mut output, u32::from(byte));
            continue;
        }
        match state {
            Ascii | Roman | Katakana => {
                if item.is_none() {
                    at_eof = true;
                } else if byte == 0x1b {
                    state = EscapeStart;
                } else if state == Roman && byte == 0x5c {
                    output_flag = false;
                    td_put(&mut output, 0x00a5);
                } else if state == Roman && byte == 0x7e {
                    output_flag = false;
                    td_put(&mut output, 0x203e);
                } else if state == Katakana && (0x21..=0x5f).contains(&byte) {
                    output_flag = false;
                    td_put(&mut output, 0xff61 + u32::from(byte - 0x21));
                } else if state != Katakana && byte < 0x80 && byte != 0x0e && byte != 0x0f {
                    output_flag = false;
                    td_put(&mut output, u32::from(byte));
                } else {
                    output_flag = false;
                    td_error(&mut output);
                }
            }
            Lead => {
                if item.is_none() {
                    at_eof = true;
                } else if byte == 0x1b {
                    state = EscapeStart;
                } else if (0x21..=0x7e).contains(&byte) {
                    output_flag = false;
                    lead = byte;
                    state = Trail;
                } else {
                    if byte != 0x0e && byte != 0x0f && index < input.len() {
                        let next = input[index];
                        let starts_item = next == 0x0e
                            || next == 0x0f
                            || next == 0x1b
                            || (0x21..=0x7e).contains(&next);
                        index += usize::from(!starts_item);
                    }
                    output_flag = false;
                    td_error(&mut output);
                }
            }
            Trail => {
                if item.is_none() {
                    state = Lead;
                    td_error(&mut output);
                    at_eof = true;
                } else if byte == 0x1b {
                    state = EscapeStart;
                    td_error(&mut output);
                } else {
                    state = Lead;
                    if (0x21..=0x7e).contains(&byte) {
                        let code_point = td_table(
                            TD_JIS0208,
                            usize::from(lead - 0x21) * 94 + usize::from(byte - 0x21),
                        );
                        if code_point == 0 {
                            td_error(&mut output);
                        } else {
                            td_put(&mut output, code_point);
                        }
                    } else {
                        td_error(&mut output);
                        if byte == 0x0e || byte == 0x0f {
                            index -= 1;
                        }
                    }
                }
            }
            EscapeStart => {
                if item.is_some() && matches!(byte, 0x24 | 0x25 | 0x26 | 0x28 | 0x2e) {
                    lead = byte;
                    state = Escape;
                } else if item.is_some() && byte == 0x4f {
                    output_flag = false;
                    state = output_state;
                    td_error(&mut output);
                } else {
                    if item.is_some() {
                        index -= 1;
                    }
                    output_flag = false;
                    state = output_state;
                    td_error(&mut output);
                    at_eof = item.is_none();
                }
            }
            Escape => {
                let next = if item.is_some() && lead == 0x28 && byte == 0x42 {
                    Some(Ascii)
                } else if item.is_some() && lead == 0x28 && (byte == 0x48 || byte == 0x4a) {
                    Some(Roman)
                } else if item.is_some() && lead == 0x28 && byte == 0x49 {
                    Some(Katakana)
                } else if item.is_some() && lead == 0x24 && (byte == 0x40 || byte == 0x42) {
                    Some(Lead)
                } else {
                    None
                };
                if let Some(next) = next {
                    state = next;
                    output_state = next;
                    let repeated = output_flag;
                    output_flag = !repeated;
                    if repeated {
                        td_error(&mut output);
                    }
                    continue;
                }

                let extended = (lead == 0x24 && matches!(byte, 0x28..=0x2b))
                    || (lead == 0x25 && byte == 0x2f);
                if extended && index == input.len() {
                    output_flag = false;
                    state = output_state;
                    td_error(&mut output);
                    continue;
                }
                if extended {
                    let final_byte = input[index];
                    let known = (lead == 0x24
                        && byte == 0x28
                        && ((0x40..=0x45).contains(&final_byte)
                            || (0x47..=0x4d).contains(&final_byte)))
                        || (lead == 0x24
                            && byte == 0x29
                            && matches!(final_byte, 0x41 | 0x43 | 0x45 | 0x47))
                        || (lead == 0x24 && byte == 0x2a && final_byte == 0x48)
                        || (lead == 0x24
                            && byte == 0x2b
                            && (0x49..=0x4d).contains(&final_byte))
                        || (lead == 0x25
                            && byte == 0x2f
                            && ((0x40..=0x41).contains(&final_byte)
                                || (0x43..=0x46).contains(&final_byte)));
                    if known {
                        index += 1;
                        output_flag = false;
                        state = output_state;
                        td_error(&mut output);
                        continue;
                    }
                }

                let consume_error = (lead == 0x24 && byte == 0x41)
                    || (lead == 0x28
                        && ((0x40..=0x47).contains(&byte) || byte == 0x4b || byte == 0x52))
                    || (lead == 0x25 && byte == 0x42)
                    || (lead == 0x2e && (byte == 0x41 || byte == 0x46));
                if item.is_some() && lead == 0x26 && byte == 0x40 {
                    state = Lead;
                    output_state = Lead;
                    let repeated = output_flag;
                    output_flag = !repeated;
                    if repeated {
                        td_error(&mut output);
                    }
                } else if item.is_none() || consume_error {
                    output_flag = false;
                    state = output_state;
                    td_error(&mut output);
                    at_eof = item.is_none();
                } else {
                    index -= 1;
                    replay = Some(lead);
                    output_flag = false;
                    state = output_state;
                    td_error(&mut output);
                }
            }
        }
    }
    Rc::from(output)
}

pub fn text_decode_legacy(bytes: &JsBytes<u8>, encoding: f64) -> JsString {
    let input = td_input(bytes);
    match encoding as usize {
        encoding if encoding < TD_SINGLE_COUNT => td_single_byte(&input, encoding),
        27 => td_x_user_defined(&input),
        28 => td_utf16(&input, false),
        29 => td_utf16(&input, true),
        30 => td_gb18030(&input),
        31 => td_big5(&input),
        32 => td_euc_jp(&input),
        33 => td_iso_2022_jp(&input),
        34 => td_shift_jis(&input),
        35 => td_euc_kr(&input),
        _ => unreachable!("scriptc: invalid static TextDecoder encoding"),
    }
}
