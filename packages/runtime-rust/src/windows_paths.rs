fn windows_path_separator(byte: u8) -> bool {
    matches!(byte, b'/' | b'\\')
}

fn windows_device_root(byte: u8) -> bool {
    byte.is_ascii_alphabetic()
}

fn windows_reserved_name(path: &[u8], colon: Option<usize>) -> bool {
    const NAMES: &[&[u8]] = &[
        b"CON", b"PRN", b"AUX", b"NUL", b"COM1", b"COM2", b"COM3", b"COM4", b"COM5",
        b"COM6", b"COM7", b"COM8", b"COM9", b"LPT1", b"LPT2", b"LPT3", b"LPT4", b"LPT5",
        b"LPT6", b"LPT7", b"LPT8", b"LPT9", "COM¹".as_bytes(), "COM²".as_bytes(),
        "COM³".as_bytes(), "LPT¹".as_bytes(), "LPT²".as_bytes(), "LPT³".as_bytes(),
    ];
    let end = match colon {
        Some(index) => index.min(path.len()),
        None => {
            let Some((index, character)) = std::str::from_utf8(path)
                .ok()
                .and_then(|value| value.char_indices().next_back())
            else {
                return false;
            };
            if character.len_utf16() == 2 {
                return false;
            }
            index
        }
    };
    NAMES
        .iter()
        .any(|name| name.len() == end && path[..end].eq_ignore_ascii_case(name))
}

fn normalize_windows_segments(path: &[u8], allow_above_root: bool) -> Vec<u8> {
    let mut segments: Vec<&[u8]> = Vec::new();
    for segment in path.split(|byte| windows_path_separator(*byte)) {
        match segment {
            b"" | b"." => {}
            b".." => {
                if segments.last().is_some_and(|last| *last != b"..") {
                    segments.pop();
                } else if allow_above_root {
                    segments.push(segment);
                }
            }
            _ => segments.push(segment),
        }
    }
    let length = segments.iter().map(|segment| segment.len()).sum::<usize>()
        + segments.len().saturating_sub(1);
    let mut normalized = Vec::with_capacity(length);
    for (index, segment) in segments.into_iter().enumerate() {
        if index > 0 {
            normalized.push(b'\\');
        }
        normalized.extend_from_slice(segment);
    }
    normalized
}

fn normalize_windows_path(path: &[u8]) -> Vec<u8> {
    if path.is_empty() {
        return b".".to_vec();
    }
    if path.len() == 1 {
        return vec![if path[0] == b'/' { b'\\' } else { path[0] }];
    }

    let mut root_end = 0usize;
    let mut device = Vec::new();
    let mut has_device = false;
    let mut absolute = false;
    if windows_path_separator(path[0]) {
        absolute = true;
        if windows_path_separator(path[1]) {
            let mut index = 2usize;
            let mut last = 2usize;
            while index < path.len() && !windows_path_separator(path[index]) {
                index += 1;
            }
            if index < path.len() && index != last {
                let server = &path[last..index];
                last = index;
                while index < path.len() && windows_path_separator(path[index]) {
                    index += 1;
                }
                if index < path.len() && index != last {
                    last = index;
                    while index < path.len() && !windows_path_separator(path[index]) {
                        index += 1;
                    }
                    if index == path.len() || index != last {
                        if server.len() == 1 && matches!(server[0], b'.' | b'?') {
                            device.extend_from_slice(b"\\\\");
                            device.extend_from_slice(server);
                            has_device = true;
                            root_end = 4;
                            if let Some(colon) = path.iter().position(|byte| *byte == b':') {
                                if colon >= 4 {
                                    let candidate = &path[4..=colon];
                                    if windows_reserved_name(candidate, Some(candidate.len() - 1)) {
                                        device.clear();
                                        device.extend_from_slice(b"\\\\?\\");
                                        device.extend_from_slice(candidate);
                                        root_end = colon + 1;
                                    }
                                }
                            }
                        } else if index == path.len() {
                            let mut result = b"\\\\".to_vec();
                            result.extend_from_slice(server);
                            result.push(b'\\');
                            result.extend_from_slice(&path[last..]);
                            result.push(b'\\');
                            return result;
                        } else {
                            device.extend_from_slice(b"\\\\");
                            device.extend_from_slice(server);
                            device.push(b'\\');
                            device.extend_from_slice(&path[last..index]);
                            has_device = true;
                            root_end = index;
                        }
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else if let Some(colon) = path.iter().position(|byte| *byte == b':') {
        if colon > 0 {
            if windows_device_root(path[0]) && colon == 1 {
                device.extend_from_slice(&path[..2]);
                has_device = true;
                root_end = 2;
                if path.get(2).is_some_and(|byte| windows_path_separator(*byte)) {
                    absolute = true;
                    root_end = 3;
                }
            } else if windows_reserved_name(path, Some(colon)) {
                device.extend_from_slice(&path[..=colon]);
                has_device = true;
                root_end = colon + 1;
            }
        }
    }

    let mut tail = normalize_windows_segments(&path[root_end..], !absolute);
    if tail.is_empty() && !absolute {
        tail.push(b'.');
    }
    if !tail.is_empty() && windows_path_separator(path[path.len() - 1]) {
        tail.push(b'\\');
    }
    if !absolute && !has_device && path.contains(&b':') {
        let looks_like_drive = tail.len() >= 2 && windows_device_root(tail[0]) && tail[1] == b':';
        let unsafe_colon = path.iter().enumerate().any(|(index, byte)| {
            *byte == b':'
                && (index + 1 == path.len() || windows_path_separator(path[index + 1]))
        });
        if looks_like_drive || unsafe_colon {
            let mut result = b".\\".to_vec();
            result.extend_from_slice(&tail);
            return result;
        }
    }
    let colon = path.iter().position(|byte| *byte == b':');
    if windows_reserved_name(path, colon) {
        let mut result = b".\\".to_vec();
        result.extend_from_slice(&device);
        result.extend_from_slice(&tail);
        return result;
    }

    let mut result = Vec::with_capacity(device.len() + tail.len() + usize::from(absolute));
    if has_device {
        result.extend_from_slice(&device);
    }
    if absolute {
        result.push(b'\\');
    }
    result.extend_from_slice(&tail);
    result
}

pub fn path_win32_join(parts: &JsArray<JsString>) -> JsString {
    let (mut joined, first_length) = parts.with(|data| {
        let mut joined = Vec::new();
        let mut first_length = 0usize;
        for part in data.elements.iter().filter(|part| !part.is_empty()) {
            if joined.is_empty() {
                first_length = part.len();
            } else {
                joined.push(b'\\');
            }
            joined.extend_from_slice(part.as_bytes());
        }
        (joined, first_length)
    });
    if joined.is_empty() {
        return string(".");
    }

    let mut slash_count = 0usize;
    let mut replace_slashes = true;
    if windows_path_separator(joined[0]) {
        slash_count = 1;
        if first_length > 1 && windows_path_separator(joined[1]) {
            slash_count = 2;
            if first_length > 2 {
                if windows_path_separator(joined[2]) {
                    slash_count = 3;
                } else {
                    replace_slashes = false;
                }
            }
        }
    }
    if replace_slashes {
        while slash_count < joined.len() && windows_path_separator(joined[slash_count]) {
            slash_count += 1;
        }
        if slash_count >= 2 {
            joined.drain(1..slash_count);
            joined[0] = b'\\';
        }
    }

    let reserved = joined.split(|byte| *byte == b'\\').any(|segment| {
        segment
            .iter()
            .position(|byte| *byte == b':')
            .is_some_and(|colon| windows_reserved_name(segment, Some(colon)))
    });
    let result = if reserved {
        joined
            .into_iter()
            .map(|byte| if byte == b'/' { b'\\' } else { byte })
            .collect()
    } else {
        normalize_windows_path(&joined)
    };
    Rc::from(String::from_utf8(result).expect("scriptc: Windows path must remain UTF-8"))
}
