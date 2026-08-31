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
                            if let Some(colon) = path.iter().position(|byte| *byte == b':')
                                && colon >= 4
                            {
                                let candidate = &path[4..=colon];
                                if windows_reserved_name(candidate, Some(candidate.len() - 1)) {
                                    device.clear();
                                    device.extend_from_slice(b"\\\\?\\");
                                    device.extend_from_slice(candidate);
                                    root_end = colon + 1;
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
    } else if let Some(colon) = path.iter().position(|byte| *byte == b':')
        && colon > 0
    {
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

pub fn path_win32_normalize(path: &JsString) -> JsString {
    Rc::from(
        String::from_utf8(normalize_windows_path(path.as_bytes()))
            .expect("scriptc: normalized Windows path must remain UTF-8"),
    )
}

fn windows_resolve_root(path: &[u8]) -> (Vec<u8>, usize, bool) {
    let mut device = Vec::new();
    let mut root_end = 0usize;
    let mut absolute = false;
    if path.len() == 1 {
        if windows_path_separator(path[0]) {
            root_end = 1;
            absolute = true;
        }
    } else if windows_path_separator(path[0]) {
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
                        device.extend_from_slice(b"\\\\");
                        device.extend_from_slice(server);
                        if server.len() == 1 && matches!(server[0], b'.' | b'?') {
                            root_end = 4;
                        } else {
                            device.push(b'\\');
                            device.extend_from_slice(&path[last..index]);
                            root_end = index;
                        }
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else if windows_device_root(path[0]) && path[1] == b':' {
        device.extend_from_slice(&path[..2]);
        root_end = 2;
        if path.get(2).is_some_and(|byte| windows_path_separator(*byte)) {
            absolute = true;
            root_end = 3;
        }
    }
    (device, root_end, absolute)
}

fn windows_ascii_eq(left: &[u8], right: &[u8]) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn windows_cwd() -> Vec<u8> {
    let mut cwd = process_cwd().as_bytes().to_vec();
    if !cfg!(windows) {
        for byte in &mut cwd {
            if *byte == b'/' {
                *byte = b'\\';
            }
        }
    }
    cwd
}

fn resolve_windows_path(parts: &JsArray<JsString>, cwd: &[u8]) -> JsString {
    let inputs = parts.with(|data| {
        data.elements
            .iter()
            .map(|part| part.as_bytes().to_vec())
            .collect::<Vec<_>>()
    });
    let mut resolved_device = Vec::new();
    let mut resolved_tail = Vec::new();
    let mut resolved_absolute = false;
    let mut index = inputs.len() as isize - 1;
    while index >= -1 {
        let path = if index >= 0 {
            let value = inputs[index as usize].clone();
            if value.is_empty() {
                index -= 1;
                continue;
            }
            value
        } else if resolved_device.is_empty() {
            let cwd = cwd.to_vec();
            let fast = inputs.is_empty()
                || (inputs.len() == 1
                    && (inputs[0].is_empty() || inputs[0] == b".")
                    && cwd.first().is_some_and(|byte| windows_path_separator(*byte)));
            if fast {
                return Rc::from(
                    String::from_utf8(cwd).expect("scriptc: Windows cwd must remain UTF-8"),
                );
            }
            cwd
        } else {
            let drive = String::from_utf8_lossy(&resolved_device);
            let mut cwd = (cfg!(windows))
                .then(|| std::env::var_os(format!("={drive}")))
                .flatten()
                .map(|value| value.to_string_lossy().as_bytes().to_vec())
                .unwrap_or_else(|| cwd.to_vec());
            let same_drive = cwd.len() >= 2 && windows_ascii_eq(&cwd[..2], &resolved_device);
            if !same_drive && cwd.len() > 2 && cwd[2] == b'\\' {
                cwd.clear();
                cwd.extend_from_slice(&resolved_device);
                cwd.push(b'\\');
            }
            cwd
        };

        let (device, root_end, absolute) = windows_resolve_root(&path);
        if !device.is_empty() {
            if !resolved_device.is_empty() {
                if !windows_ascii_eq(&device, &resolved_device) {
                    index -= 1;
                    continue;
                }
            } else {
                resolved_device = device;
            }
        }
        if resolved_absolute {
            if !resolved_device.is_empty() {
                break;
            }
        } else {
            let mut next_tail = path[root_end..].to_vec();
            next_tail.push(b'\\');
            next_tail.extend_from_slice(&resolved_tail);
            resolved_tail = next_tail;
            resolved_absolute = absolute;
            if absolute && !resolved_device.is_empty() {
                break;
            }
        }
        index -= 1;
    }

    let normalized = normalize_windows_segments(&resolved_tail, !resolved_absolute);
    let mut result = resolved_device;
    if resolved_absolute {
        result.push(b'\\');
    }
    result.extend_from_slice(&normalized);
    if result.is_empty() {
        result.push(b'.');
    }
    Rc::from(String::from_utf8(result).expect("scriptc: resolved Windows path must remain UTF-8"))
}

pub fn path_win32_resolve(parts: &JsArray<JsString>) -> JsString {
    resolve_windows_path(parts, &windows_cwd())
}

pub fn path_win32_is_absolute(path: &JsString) -> bool {
    let path = path.as_bytes();
    path.first().is_some_and(|byte| windows_path_separator(*byte))
        || (path.len() > 2
            && windows_device_root(path[0])
            && path[1] == b':'
            && windows_path_separator(path[2]))
}

fn relative_windows_path(from: &JsString, to: &JsString, cwd: &[u8]) -> JsString {
    if from == to {
        return empty_string();
    }
    let resolved_from = resolve_windows_path(&array_new(vec![from.clone()]), cwd);
    let resolved_to = resolve_windows_path(&array_new(vec![to.clone()]), cwd);
    if resolved_from == resolved_to
        || windows_ascii_eq(resolved_from.as_bytes(), resolved_to.as_bytes())
    {
        return empty_string();
    }

    let lower = |value: &JsString| {
        value
            .bytes()
            .map(|byte| byte.to_ascii_lowercase())
            .collect::<Vec<_>>()
    };
    let from_lower = lower(&resolved_from);
    let to_lower = lower(&resolved_to);
    let mut from_start = 0isize;
    while from_start < from_lower.len() as isize && from_lower[from_start as usize] == b'\\' {
        from_start += 1;
    }
    let mut from_end = from_lower.len() as isize;
    while from_end - 1 > from_start && from_lower[(from_end - 1) as usize] == b'\\' {
        from_end -= 1;
    }
    let from_length = from_end - from_start;

    let mut to_start = 0isize;
    while to_start < to_lower.len() as isize && to_lower[to_start as usize] == b'\\' {
        to_start += 1;
    }
    let mut to_end = to_lower.len() as isize;
    while to_end - 1 > to_start && to_lower[(to_end - 1) as usize] == b'\\' {
        to_end -= 1;
    }
    let to_length = to_end - to_start;

    let length = from_length.min(to_length);
    let mut last_common_separator = -1isize;
    let mut index = 0isize;
    while index < length {
        let from_byte = from_lower[(from_start + index) as usize];
        if from_byte != to_lower[(to_start + index) as usize] {
            break;
        }
        if from_byte == b'\\' {
            last_common_separator = index;
        }
        index += 1;
    }

    if index != length {
        if last_common_separator == -1 {
            return resolved_to;
        }
    } else {
        if to_length > length {
            if to_lower[(to_start + index) as usize] == b'\\' {
                let start = to_start + index + 1;
                return Rc::from(&resolved_to[start as usize..to_end as usize]);
            }
            if index == 2 {
                let start = to_start + index;
                return Rc::from(&resolved_to[start as usize..to_end as usize]);
            }
        }
        if from_length > length {
            if from_lower[(from_start + index) as usize] == b'\\' {
                last_common_separator = index;
            } else if index == 2 {
                last_common_separator = 3;
            }
        }
        if last_common_separator == -1 {
            last_common_separator = 0;
        }
    }

    let mut result = Vec::new();
    let mut cursor = from_start + last_common_separator + 1;
    while cursor <= from_end {
        if cursor == from_end || from_lower[cursor as usize] == b'\\' {
            if !result.is_empty() {
                result.push(b'\\');
            }
            result.extend_from_slice(b"..");
        }
        cursor += 1;
    }
    to_start += last_common_separator;
    if result.is_empty()
        && to_start < resolved_to.len() as isize
        && resolved_to.as_bytes()[to_start as usize] == b'\\'
    {
        to_start += 1;
    }
    if to_end > to_start {
        result.extend_from_slice(&resolved_to.as_bytes()[to_start as usize..to_end as usize]);
    }
    Rc::from(String::from_utf8(result).expect("scriptc: relative Windows path must remain UTF-8"))
}

pub fn path_win32_relative(from: &JsString, to: &JsString) -> JsString {
    relative_windows_path(from, to, &windows_cwd())
}

fn windows_namespaced_path(path: &JsString, cwd: &[u8]) -> JsString {
    if path.is_empty() {
        return path.clone();
    }
    let resolved = resolve_windows_path(&array_new(vec![path.clone()]), cwd);
    if resolved.encode_utf16().count() <= 2 {
        return path.clone();
    }
    let bytes = resolved.as_bytes();
    if bytes.starts_with(b"\\\\")
        && !bytes
            .get(2)
            .is_some_and(|byte| matches!(*byte, b'?' | b'.'))
    {
        return Rc::from(format!("\\\\?\\UNC\\{}", &resolved[2..]));
    }
    if bytes.len() > 2
        && windows_device_root(bytes[0])
        && bytes[1] == b':'
        && bytes[2] == b'\\'
    {
        return Rc::from(format!("\\\\?\\{resolved}"));
    }
    resolved
}

pub fn path_win32_to_namespaced_path(path: &JsString) -> JsString {
    windows_namespaced_path(path, &windows_cwd())
}

pub fn path_win32_dirname(path: &JsString) -> JsString {
    let bytes = path.as_bytes();
    if bytes.is_empty() {
        return string(".");
    }
    if bytes.len() == 1 {
        return if windows_path_separator(bytes[0]) {
            path.clone()
        } else {
            string(".")
        };
    }
    let mut root_end = None;
    let mut offset = 0usize;
    if windows_path_separator(bytes[0]) {
        root_end = Some(1);
        offset = 1;
        if windows_path_separator(bytes[1]) {
            let mut index = 2usize;
            let mut last = 2usize;
            while index < bytes.len() && !windows_path_separator(bytes[index]) {
                index += 1;
            }
            if index < bytes.len() && index != last {
                last = index;
                while index < bytes.len() && windows_path_separator(bytes[index]) {
                    index += 1;
                }
                if index < bytes.len() && index != last {
                    last = index;
                    while index < bytes.len() && !windows_path_separator(bytes[index]) {
                        index += 1;
                    }
                    if index == bytes.len() {
                        return path.clone();
                    }
                    if index != last {
                        root_end = Some(index + 1);
                        offset = index + 1;
                    }
                }
            }
        }
    } else if windows_device_root(bytes[0]) && bytes[1] == b':' {
        let root = if bytes.get(2).is_some_and(|byte| windows_path_separator(*byte)) {
            3
        } else {
            2
        };
        root_end = Some(root);
        offset = root;
    }
    let mut end = None;
    let mut matched_slash = true;
    for index in (offset..bytes.len()).rev() {
        if windows_path_separator(bytes[index]) {
            if !matched_slash {
                end = Some(index);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    let end = end.or(root_end).unwrap_or(0);
    if end == 0 && root_end.is_none() {
        string(".")
    } else {
        Rc::from(&path[..end])
    }
}

pub fn path_win32_basename(path: &JsString, suffix: &JsString) -> JsString {
    let bytes = path.as_bytes();
    let suffix = suffix.as_bytes();
    let length = bytes.len() as isize;
    let mut start = 0isize;
    let mut end = -1isize;
    let mut matched_slash = true;
    if bytes.len() >= 2 && windows_device_root(bytes[0]) && bytes[1] == b':' {
        start = 2;
    }
    if !suffix.is_empty() && suffix.len() <= bytes.len() {
        if suffix == bytes {
            return empty_string();
        }
        let mut suffix_index = suffix.len() as isize - 1;
        let mut first_non_slash_end = -1isize;
        for index in (start..length).rev() {
            let byte = bytes[index as usize];
            if windows_path_separator(byte) {
                if !matched_slash {
                    start = index + 1;
                    break;
                }
            } else {
                if first_non_slash_end == -1 {
                    matched_slash = false;
                    first_non_slash_end = index + 1;
                }
                if suffix_index >= 0 {
                    if byte == suffix[suffix_index as usize] {
                        suffix_index -= 1;
                        if suffix_index == -1 {
                            end = index;
                        }
                    } else {
                        suffix_index = -1;
                        end = first_non_slash_end;
                    }
                }
            }
        }
        if start == end {
            end = first_non_slash_end;
        } else if end == -1 {
            end = length;
        }
        return Rc::from(&path[start as usize..end as usize]);
    }

    for index in (start..length).rev() {
        if windows_path_separator(bytes[index as usize]) {
            if !matched_slash {
                start = index + 1;
                break;
            }
        } else if end == -1 {
            matched_slash = false;
            end = index + 1;
        }
    }
    if end == -1 {
        empty_string()
    } else {
        Rc::from(&path[start as usize..end as usize])
    }
}

pub fn path_win32_extname(path: &JsString) -> JsString {
    let bytes = path.as_bytes();
    let mut start = 0usize;
    let mut start_part = 0usize;
    if bytes.len() >= 2 && windows_device_root(bytes[0]) && bytes[1] == b':' {
        start = 2;
        start_part = 2;
    }
    let mut start_dot = None;
    let mut end = None;
    let mut matched_slash = true;
    let mut pre_dot_state = 0i8;
    for index in (start..bytes.len()).rev() {
        let byte = bytes[index];
        if windows_path_separator(byte) {
            if !matched_slash {
                start_part = index + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            matched_slash = false;
            end = Some(index + 1);
        }
        if byte == b'.' {
            if start_dot.is_none() {
                start_dot = Some(index);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    let (Some(start_dot), Some(end)) = (start_dot, end) else {
        return empty_string();
    };
    if pre_dot_state == 0
        || (pre_dot_state == 1 && start_dot + 1 == end && start_dot == start_part + 1)
    {
        empty_string()
    } else {
        Rc::from(&path[start_dot..end])
    }
}
