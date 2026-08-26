#[derive(Clone)]
pub enum JsHttpTimeout {
    Undefined,
    Number(f64),
    String(JsString),
}

pub struct HttpServerState {
    timeouts: [JsHttpTimeout; 5],
    join_duplicate_headers: bool,
}

fn http_timeout_index(selector: f64) -> usize {
    let index = selector as usize;
    if selector.trunc() != selector || index >= 5 {
        unreachable!("scriptc invariant: invalid HTTP server timeout selector");
    }
    index
}

fn http_timeout_name(index: usize) -> &'static str {
    [
        "timeout",
        "keepAliveTimeout",
        "headersTimeout",
        "requestTimeout",
        "keepAliveTimeoutBuffer",
    ][index]
}

pub fn http_server_timeout_selector(name: &str) -> Option<f64> {
    match name {
        "timeout" => Some(0.0),
        "keepAliveTimeout" => Some(1.0),
        "headersTimeout" => Some(2.0),
        "requestTimeout" => Some(3.0),
        "keepAliveTimeoutBuffer" => Some(4.0),
        _ => None,
    }
}

pub fn http_server_new() -> JsNetServer {
    let server = net_server_new();
    server.with_mut(|server| {
        server.http = Some(HttpServerState {
            timeouts: [
                JsHttpTimeout::Number(0.0),
                JsHttpTimeout::Number(5_000.0),
                JsHttpTimeout::Number(60_000.0),
                JsHttpTimeout::Number(300_000.0),
                JsHttpTimeout::Number(1_000.0),
            ],
            join_duplicate_headers: false,
        });
    });
    server
}

pub fn http_server_join_duplicate_headers(server: &JsNetServer) {
    server.with_mut(|server| {
        server
            .http
            .as_mut()
            .expect("scriptc invariant: HTTP options on a net.Server")
            .join_duplicate_headers = true;
    });
}

pub fn http_server_timeout_get(server: &JsNetServer, selector: f64) -> f64 {
    let index = http_timeout_index(selector);
    server.with(|server| match &server
        .http
        .as_ref()
        .expect("scriptc invariant: HTTP timeout read on a net.Server")
        .timeouts[index]
    {
        JsHttpTimeout::Number(value) => *value,
        JsHttpTimeout::Undefined => throw_type_error_code(
            format!(
                "The \"{}\" argument must be of type number. Received undefined",
                http_timeout_name(index)
            ),
            "ERR_INVALID_ARG_TYPE",
        ),
        JsHttpTimeout::String(value) => throw_type_error_code(
            format!(
                "The \"{}\" argument must be of type number. Received {}",
                http_timeout_name(index),
                dynamic_specific_string(value)
            ),
            "ERR_INVALID_ARG_TYPE",
        ),
    })
}

pub fn http_server_timeout_set(server: &JsNetServer, selector: f64, value: f64) {
    let index = http_timeout_index(selector);
    server.with_mut(|server| {
        server
            .http
            .as_mut()
            .expect("scriptc invariant: HTTP timeout write on a net.Server")
            .timeouts[index] = JsHttpTimeout::Number(value);
    });
}

pub fn http_server_timeout_option_set(server: &JsNetServer, selector: f64, value: Option<f64>) {
    let Some(value) = value else {
        return;
    };
    if !value.is_finite() || value.trunc() != value || !(0.0..=9_007_199_254_740_991.0).contains(&value) {
        throw_range_error_code(
            format!(
                "The value of \"{}\" is out of range. It must be >= 0 && <= 9007199254740991. Received {}",
                http_timeout_name(http_timeout_index(selector)),
                display_number(value)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    http_server_timeout_set(server, selector, value);
}

pub fn http_server_timeout_value(server: &JsNetServer, selector: f64) -> Option<JsHttpTimeout> {
    let index = http_timeout_index(selector);
    server.with(|server| server.http.as_ref().map(|http| http.timeouts[index].clone()))
}

pub fn http_server_timeout_set_string(server: &JsNetServer, selector: f64, value: &JsString) -> bool {
    http_server_timeout_set_value(server, selector, JsHttpTimeout::String(value.clone()))
}

pub fn http_server_timeout_set_number_dynamic(
    server: &JsNetServer,
    selector: f64,
    value: f64,
) -> bool {
    http_server_timeout_set_value(server, selector, JsHttpTimeout::Number(value))
}

pub fn http_server_timeout_set_undefined(server: &JsNetServer, selector: f64) -> bool {
    http_server_timeout_set_value(server, selector, JsHttpTimeout::Undefined)
}

fn http_server_timeout_set_value(
    server: &JsNetServer,
    selector: f64,
    value: JsHttpTimeout,
) -> bool {
    let index = http_timeout_index(selector);
    server.with_mut(|server| {
        let Some(http) = server.http.as_mut() else {
            return false;
        };
        http.timeouts[index] = value;
        true
    })
}
