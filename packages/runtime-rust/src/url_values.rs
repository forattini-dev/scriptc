use crate::{
    JsArray, JsString, array_get, array_len, array_new, empty_string, path_resolve, string,
    throw_type_error, throw_type_error_code,
};
use std::cell::RefCell;
use std::rc::{Rc, Weak};

/// Shared, identity-bearing WHATWG URL value.
///
/// Interior mutability lets a live `URLSearchParams` view update its owning
/// URL while ordinary URL getters remain pure reads.
pub struct UrlData {
    value: RefCell<url::Url>,
    extra_file_slashes: usize,
    search_params: RefCell<Option<Weak<SearchParamsData>>>,
}

pub type JsUrl = Rc<UrlData>;

fn url_from_parsed(value: url::Url, extra_file_slashes: usize) -> JsUrl {
    Rc::new(UrlData {
        value: RefCell::new(value),
        extra_file_slashes,
        search_params: RefCell::new(None),
    })
}

pub fn url_new(input: &JsString) -> JsUrl {
    let value =
        url::Url::parse(input).unwrap_or_else(|_| throw_type_error("Invalid URL".to_owned()));
    // The url crate collapses every host-less file path to one leading slash.
    // WHATWG/Node preserve each slash beyond the authority marker.
    let trimmed = input.trim_matches(|character: char| character <= ' ');
    let bytes = trimmed.as_bytes();
    let extra_file_slashes = if bytes.len() >= 5 && bytes[..5].eq_ignore_ascii_case(b"file:") {
        let leading = bytes[5..].iter().take_while(|byte| **byte == b'/').count();
        leading.saturating_sub(3)
    } else {
        0
    };
    url_from_parsed(value, extra_file_slashes)
}

pub fn url_protocol(value: &JsUrl) -> JsString {
    let value = value.value.borrow();
    string(&format!("{}:", value.scheme()))
}

pub fn url_hostname(value: &JsUrl) -> JsString {
    let value = value.value.borrow();
    string(value.host_str().unwrap_or(""))
}

pub fn url_host(value: &JsUrl) -> JsString {
    let value = value.value.borrow();
    let Some(hostname) = value.host_str() else {
        return empty_string();
    };
    match value.port() {
        Some(port) => string(&format!("{hostname}:{port}")),
        None => string(hostname),
    }
}

pub fn url_pathname(value: &JsUrl) -> JsString {
    let parsed = value.value.borrow();
    if value.extra_file_slashes == 0 {
        return string(parsed.path());
    }
    string(&format!(
        "{}{}",
        "/".repeat(value.extra_file_slashes),
        parsed.path()
    ))
}

pub fn url_href(value: &JsUrl) -> JsString {
    let parsed = value.value.borrow();
    if value.extra_file_slashes == 0 {
        return string(parsed.as_str());
    }
    let href = parsed.as_str();
    debug_assert!(href.starts_with("file://"));
    string(&format!(
        "{}{}{}",
        &href[..7],
        "/".repeat(value.extra_file_slashes),
        &href[7..]
    ))
}

fn percent_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(not(windows))]
fn file_url_path(value: &JsUrl) -> JsString {
    let parsed = value.value.borrow();
    if parsed.scheme() != "file" {
        throw_type_error("The URL must be of scheme file".to_owned());
    }
    if let Some(host) = parsed.host_str().filter(|host| !host.is_empty()) {
        let _ = host;
        let platform = if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "posix"
        };
        throw_type_error(format!(
            "File URL host must be \"localhost\" or empty on {platform}"
        ));
    }
    let encoded = parsed.path().as_bytes();
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        if encoded[index] == b'%' && index + 2 < encoded.len() {
            if let (Some(high), Some(low)) = (
                percent_hex(encoded[index + 1]),
                percent_hex(encoded[index + 2]),
            ) {
                let byte = high << 4 | low;
                if byte == b'/' {
                    throw_type_error(
                        "File URL path must not include encoded / characters".to_owned(),
                    );
                }
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(encoded[index]);
        index += 1;
    }
    Rc::from(String::from_utf8_lossy(&decoded).into_owned())
}

#[cfg(windows)]
fn file_url_path(value: &JsUrl) -> JsString {
    let parsed = value.value.borrow();
    if parsed.scheme() != "file" {
        throw_type_error("The URL must be of scheme file".to_owned());
    }
    let encoded = parsed.path().as_bytes();
    if encoded.windows(3).any(|window| {
        window[0] == b'%'
            && ((window[1] == b'2' && window[2].eq_ignore_ascii_case(&b'f'))
                || (window[1] == b'5' && window[2].eq_ignore_ascii_case(&b'c')))
    }) {
        throw_type_error("File URL path must not include encoded \\ or / characters".to_owned());
    }
    parsed
        .to_file_path()
        .ok()
        .and_then(|path| path.into_os_string().into_string().ok())
        .map(|path| Rc::from(path.as_str()))
        .unwrap_or_else(|| throw_type_error("File URL path must be absolute".to_owned()))
}

pub fn url_file_url_to_path(value: &JsUrl) -> JsString {
    file_url_path(value)
}

pub fn url_string_to_path(value: &JsString) -> JsString {
    file_url_path(&url_new(value))
}

#[cfg(not(windows))]
pub fn url_path_to_file_url(path: &JsString) -> JsUrl {
    let trailing_slash = path.ends_with('/');
    let resolved = path_resolve(&array_new(vec![path.clone()]));
    let mut resolved = resolved.to_string();
    if trailing_slash && resolved != "/" && !resolved.ends_with('/') {
        resolved.push('/');
    }
    let parsed = url::Url::from_file_path(&resolved)
        .unwrap_or_else(|_| throw_type_error("Invalid URL".to_owned()));
    url_from_parsed(parsed, 0)
}

#[cfg(windows)]
pub fn url_path_to_file_url(path: &JsString) -> JsUrl {
    let path = std::path::PathBuf::from(path.as_ref());
    let resolved = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|error| throw_type_error(error.to_string()))
            .join(path)
    };
    let parsed = url::Url::from_file_path(resolved)
        .unwrap_or_else(|_| throw_type_error("Invalid URL".to_owned()));
    url_from_parsed(parsed, 0)
}

pub struct SearchParamsData {
    pairs: RefCell<Vec<(JsString, JsString)>>,
    owner: Option<JsUrl>,
}

pub type JsSearchParams = Rc<SearchParamsData>;

fn search_params_from_pairs(
    pairs: Vec<(JsString, JsString)>,
    owner: Option<JsUrl>,
) -> JsSearchParams {
    Rc::new(SearchParamsData {
        pairs: RefCell::new(pairs),
        owner,
    })
}

fn search_params_parse_text(init: &str) -> Vec<(JsString, JsString)> {
    let init = init.strip_prefix('?').unwrap_or(init);
    url::form_urlencoded::parse(init.as_bytes())
        .map(|(name, value)| (string(&name), string(&value)))
        .collect()
}

fn search_params_serialize(value: &JsSearchParams) -> String {
    let pairs = value.pairs.borrow();
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, pair_value) in pairs.iter() {
        serializer.append_pair(name, pair_value);
    }
    serializer.finish()
}

fn search_params_sync_owner(value: &JsSearchParams) {
    let Some(owner) = &value.owner else {
        return;
    };
    let query = search_params_serialize(value);
    owner
        .value
        .borrow_mut()
        .set_query(if query.is_empty() { None } else { Some(&query) });
}

pub fn search_params_new() -> JsSearchParams {
    search_params_from_pairs(Vec::new(), None)
}

pub fn search_params_parse(init: &JsString) -> JsSearchParams {
    search_params_from_pairs(search_params_parse_text(init), None)
}

pub fn search_params_copy(source: &JsSearchParams) -> JsSearchParams {
    search_params_from_pairs(source.pairs.borrow().clone(), None)
}

pub fn search_params_from_array(rows: &JsArray<JsArray<JsString>>) -> JsSearchParams {
    let len = array_len(rows) as usize;
    for index in 0..len {
        let row = array_get(rows, index as f64);
        if array_len(&row) != 2.0 {
            throw_type_error_code(
                "Each query pair must be an iterable [name, value] tuple".to_owned(),
                "ERR_INVALID_TUPLE",
            );
        }
    }
    let mut pairs = Vec::with_capacity(len);
    for index in 0..len {
        let row = array_get(rows, index as f64);
        pairs.push((array_get(&row, 0.0), array_get(&row, 1.0)));
    }
    search_params_from_pairs(pairs, None)
}

pub fn search_params_with(
    value: &JsSearchParams,
    name: &JsString,
    pair_value: &JsString,
) -> JsSearchParams {
    value
        .pairs
        .borrow_mut()
        .push((name.clone(), pair_value.clone()));
    value.clone()
}

pub fn url_search_params(value: &JsUrl) -> JsSearchParams {
    if let Some(cached) = value
        .search_params
        .borrow()
        .as_ref()
        .and_then(Weak::upgrade)
    {
        return cached;
    }
    let pairs = value
        .value
        .borrow()
        .query()
        .map(search_params_parse_text)
        .unwrap_or_default();
    let params = search_params_from_pairs(pairs, Some(value.clone()));
    *value.search_params.borrow_mut() = Some(Rc::downgrade(&params));
    params
}

pub fn url_search(value: &JsUrl) -> JsString {
    let parsed = value.value.borrow();
    match parsed.query() {
        Some(query) if !query.is_empty() => string(&format!("?{query}")),
        _ => empty_string(),
    }
}

pub fn search_params_append(value: &JsSearchParams, name: &JsString, pair_value: &JsString) {
    value
        .pairs
        .borrow_mut()
        .push((name.clone(), pair_value.clone()));
    search_params_sync_owner(value);
}

pub fn search_params_set(value: &JsSearchParams, name: &JsString, pair_value: &JsString) {
    let mut pairs = value.pairs.borrow_mut();
    let mut replaced = false;
    let mut index = 0;
    while index < pairs.len() {
        if pairs[index].0.as_ref() == name.as_ref() {
            if replaced {
                pairs.remove(index);
                continue;
            }
            pairs[index].1 = pair_value.clone();
            replaced = true;
        }
        index += 1;
    }
    if !replaced {
        pairs.push((name.clone(), pair_value.clone()));
    }
    drop(pairs);
    search_params_sync_owner(value);
}

fn search_params_delete_impl(
    value: &JsSearchParams,
    name: &JsString,
    pair_value: Option<&JsString>,
) {
    value
        .pairs
        .borrow_mut()
        .retain(|(candidate_name, candidate_value)| {
            candidate_name.as_ref() != name.as_ref()
                || pair_value.is_some_and(|expected| candidate_value.as_ref() != expected.as_ref())
        });
    search_params_sync_owner(value);
}

pub fn search_params_delete(value: &JsSearchParams, name: &JsString) {
    search_params_delete_impl(value, name, None);
}

pub fn search_params_delete_value(value: &JsSearchParams, name: &JsString, pair_value: &JsString) {
    search_params_delete_impl(value, name, Some(pair_value));
}

pub fn search_params_get(value: &JsSearchParams, name: &JsString) -> Option<JsString> {
    value
        .pairs
        .borrow()
        .iter()
        .find(|(candidate, _)| candidate.as_ref() == name.as_ref())
        .map(|(_, pair_value)| pair_value.clone())
}

pub fn search_params_get_all(value: &JsSearchParams, name: &JsString) -> JsArray<JsString> {
    array_new(
        value
            .pairs
            .borrow()
            .iter()
            .filter(|(candidate, _)| candidate.as_ref() == name.as_ref())
            .map(|(_, pair_value)| pair_value.clone())
            .collect(),
    )
}

pub fn search_params_has(value: &JsSearchParams, name: &JsString) -> bool {
    value
        .pairs
        .borrow()
        .iter()
        .any(|(candidate, _)| candidate.as_ref() == name.as_ref())
}

pub fn search_params_has_value(
    value: &JsSearchParams,
    name: &JsString,
    pair_value: &JsString,
) -> bool {
    value
        .pairs
        .borrow()
        .iter()
        .any(|(candidate_name, candidate_value)| {
            candidate_name.as_ref() == name.as_ref()
                && candidate_value.as_ref() == pair_value.as_ref()
        })
}

pub fn search_params_sort(value: &JsSearchParams) {
    value
        .pairs
        .borrow_mut()
        .sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
    search_params_sync_owner(value);
}

pub fn search_params_size(value: &JsSearchParams) -> f64 {
    value.pairs.borrow().len() as f64
}

pub fn search_params_to_string(value: &JsSearchParams) -> JsString {
    string(&search_params_serialize(value))
}

fn search_params_at(value: &JsSearchParams, index: f64, pair_value: bool) -> JsString {
    if !index.is_finite() || index < 0.0 || index.fract() != 0.0 {
        return empty_string();
    }
    value
        .pairs
        .borrow()
        .get(index as usize)
        .map(|pair| {
            if pair_value {
                pair.1.clone()
            } else {
                pair.0.clone()
            }
        })
        .unwrap_or_else(empty_string)
}

pub fn search_params_key_at(value: &JsSearchParams, index: f64) -> JsString {
    search_params_at(value, index, false)
}

pub fn search_params_value_at(value: &JsSearchParams, index: f64) -> JsString {
    search_params_at(value, index, true)
}
