use super::*;

pub(super) fn expression(
    value: &Expr,
    function: &Function,
    module: &Emission<'_>,
) -> Option<String> {
    let Expr::LibCall { r#fn, args, .. } = value else {
        return None;
    };
    if r#fn == "bun.connect" {
        return Some(format!(
            "native_bun_connect({}, {}, {}, {}, {}, {}, {})",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
            expr(&args[2], function, module),
            expr(&args[3], function, module),
            expr(&args[4], function, module),
            expr(&args[5], function, module),
            expr(&args[6], function, module),
        ));
    }
    if r#fn == "net.createServer" {
        return Some("native_net_server_value(runtime::net_server_new())".into());
    }
    if r#fn == "http.createServer" {
        return Some("native_http_server_value(runtime::http_server_new())".into());
    }
    if r#fn == "http.createServerListener" {
        let callback = values::boxed(&args[0].ty(), &expr(&args[0], function, module), module);
        return Some(format!(
            "{{ let callback = {callback}; let server = runtime::http_server_new(); native_net_server_listener(&server, &runtime::string(\"request\"), callback, false); native_http_server_value(server) }}"
        ));
    }
    if r#fn == "net.socketNew" {
        return Some("native_net_socket_value(runtime::net_socket_new())".into());
    }
    if r#fn == "net.createServerListener" {
        let callback = values::boxed(&args[0].ty(), &expr(&args[0], function, module), module);
        return Some(format!(
            "{{ let callback = {callback}; let server = runtime::net_server_new(); native_net_server_listener(&server, &runtime::string(\"connection\"), callback, false); native_net_server_value(server) }}"
        ));
    }
    if r#fn == "net.connectOptions" {
        return Some(format!(
            "{{ let options = {}; let host = native_value_string(native_value_get(options.clone(), runtime::string(\"host\"))); let port = native_compare_number(&native_value_get(options, runtime::string(\"port\"))); let socket = runtime::net_socket_connect(port, &host); native_net_socket_value(socket) }}",
            expr(&args[0], function, module),
        ));
    }
    if r#fn == "tls.connectOptions" {
        return Some(format!(
            "{{ let options = {}; let callback = {}; native_tls_connect_options(options, callback) }}",
            expr(&args[0], function, module),
            expr(&args[1], function, module),
        ));
    }
    (r#fn == "net.createConnectionPath").then(|| {
        format!(
            "{{ let socket = runtime::net_socket_connect_path(&({})); native_net_socket_value(socket) }}",
            expr(&args[0], function, module)
        )
    })
}
