struct HttpAgentEntry {
    name: JsString,
    request: JsHttpClientRequest,
    queued: bool,
}

pub struct HttpAgentData {
    secure: bool,
    keep_alive: bool,
    keep_alive_msecs: f64,
    max_sockets: f64,
    max_free_sockets: f64,
    timeout: f64,
    default_port: f64,
    destroyed: bool,
    entries: Vec<HttpAgentEntry>,
}

impl Trace for HttpAgentData {
    fn trace(&self, tracer: &mut Tracer<'_>) {
        for entry in &self.entries {
            tracer.edge(&entry.request);
        }
    }
}

impl ClearEdges for HttpAgentData {
    fn clear_edges(&mut self) {
        self.destroyed = true;
        self.entries.clear();
    }
}

pub type JsHttpAgent = Gc<HttpAgentData>;

pub fn http_agent_new(
    secure: bool,
    keep_alive: bool,
    keep_alive_msecs: f64,
    max_sockets: f64,
    max_free_sockets: f64,
    timeout: f64,
    port: f64,
) -> JsHttpAgent {
    if keep_alive {
        throw_error(
            "an http Agent with keepAlive: true (socket pooling and reuse — compiled clients \
             dial one connection per request and close it with the response) is not supported \
             yet — construct the Agent without keepAlive, or drop the agent option"
                .to_owned(),
        );
    }
    Gc::new(HttpAgentData {
        secure,
        keep_alive: false,
        keep_alive_msecs: if keep_alive_msecs >= 0.0 { keep_alive_msecs } else { 1_000.0 },
        max_sockets: if max_sockets >= 0.0 { max_sockets } else { f64::INFINITY },
        max_free_sockets: if max_free_sockets >= 0.0 { max_free_sockets } else { 256.0 },
        timeout,
        default_port: if port >= 0.0 { port } else if secure { 443.0 } else { 80.0 },
        destroyed: false,
        entries: Vec::new(),
    })
}

pub fn http_agent_name(
    host: Option<&JsString>,
    port: Option<&JsString>,
    local_address: Option<&JsString>,
    family: f64,
    socket_path: Option<&JsString>,
) -> JsString {
    let mut output = host.map_or_else(|| "localhost".to_owned(), ToString::to_string);
    output.push(':');
    if let Some(port) = port {
        output.push_str(port);
    }
    output.push(':');
    if let Some(local_address) = local_address {
        output.push_str(local_address);
    }
    if family == 4.0 || family == 6.0 {
        output.push(':');
        output.push(if family == 4.0 { '4' } else { '6' });
    }
    if let Some(socket_path) = socket_path {
        output.push(':');
        output.push_str(socket_path);
    }
    string(&output)
}

pub fn http_agent_max_sockets(agent: &JsHttpAgent) -> f64 {
    agent.with(|agent| agent.max_sockets)
}

pub fn http_agent_max_free_sockets(agent: &JsHttpAgent) -> f64 {
    agent.with(|agent| agent.max_free_sockets)
}

pub fn http_agent_keep_alive(agent: &JsHttpAgent) -> bool {
    agent.with(|agent| agent.keep_alive)
}

pub fn http_agent_keep_alive_msecs(agent: &JsHttpAgent) -> f64 {
    agent.with(|agent| agent.keep_alive_msecs)
}

pub fn http_agent_default_port(agent: &JsHttpAgent) -> f64 {
    agent.with(|agent| agent.default_port)
}

pub fn http_agent_protocol(agent: &JsHttpAgent) -> JsString {
    agent.with(|agent| string(if agent.secure { "https:" } else { "http:" }))
}

pub fn http_agent_number_set(agent: &JsHttpAgent, key: &str, value: f64) -> bool {
    agent.with_mut(|agent| {
        match key {
            "defaultPort" => agent.default_port = value,
            "maxSockets" => agent.max_sockets = value,
            "maxFreeSockets" => agent.max_free_sockets = value,
            "keepAliveMsecs" => agent.keep_alive_msecs = value,
            _ => return false,
        }
        true
    })
}

pub fn http_agent_sockets(agent: &JsHttpAgent) -> Vec<(JsString, JsNetSocket)> {
    agent.with(|agent| {
        agent
            .entries
            .iter()
            .filter(|entry| !entry.queued)
            .filter_map(|entry| {
                entry
                    .request
                    .with(|request| request.socket.clone())
                    .map(|socket| (entry.name.clone(), socket))
            })
            .collect()
    })
}

pub fn http_agent_queued_names(agent: &JsHttpAgent) -> Vec<JsString> {
    agent.with(|agent| {
        agent
            .entries
            .iter()
            .filter(|entry| entry.queued)
            .map(|entry| entry.name.clone())
            .collect()
    })
}

fn http_agent_request_port(agent: &JsHttpAgent, port: f64, secure: bool) -> f64 {
    if port >= 0.0 {
        return port;
    }
    agent.with(|agent| {
        if agent.default_port > 0.0 {
            agent.default_port
        } else if secure {
            443.0
        } else {
            80.0
        }
    })
}

fn http_agent_track(
    agent: &JsHttpAgent,
    request: &JsHttpClientRequest,
    name: JsString,
    queued: bool,
) {
    request.with_mut(|request| {
        request.agent = Some(agent.clone());
    });
    agent.with_mut(|agent| {
        agent.entries.push(HttpAgentEntry {
            name,
            request: request.clone(),
            queued,
        });
    });
}

fn http_agent_request_slot(
    agent: &JsHttpAgent,
    host: &JsString,
    port: f64,
) -> (JsString, bool) {
    let port = string(&display_number(port));
    let name = http_agent_name(Some(host), Some(&port), None, 0.0, None);
    let queued = agent.with(|agent| {
        let active = agent
            .entries
            .iter()
            .filter(|entry| !entry.queued && entry.name.as_ref() == name.as_ref())
            .count() as f64;
        agent.max_sockets.is_finite() && active >= agent.max_sockets.max(0.0).floor()
    });
    (name, queued)
}

fn http_agent_client_request_impl(
    agent: &JsHttpAgent,
    host: &JsString,
    port: f64,
    path: &JsString,
    method: &JsString,
    timeout: f64,
    headers: &JsArray<JsString>,
    auto_end: bool,
    secure: bool,
    reject_unauthorized: bool,
    ca: &JsString,
    callback: Option<(Rc<dyn Fn(JsHttpRequest)>, NetTrace)>,
) -> JsHttpClientRequest {
    let expected_secure = agent.with(|agent| agent.secure);
    if expected_secure != secure {
        throw_type_error(format!(
            "Protocol \"{}\" not supported. Expected \"{}\"",
            if secure { "https:" } else { "http:" },
            if expected_secure { "https:" } else { "http:" },
        ));
    }
    let port = http_agent_request_port(agent, port, secure);
    let timeout = if timeout > 0.0 {
        timeout
    } else {
        agent.with(|agent| agent.timeout.max(0.0))
    };
    let (name, queued) = http_agent_request_slot(agent, host, port);
    let socket = (!secure).then(|| net_socket_connect_deferred(port, host));
    let request = http_client_new_with_socket(
        host,
        port,
        path,
        method,
        secure,
        timeout,
        headers,
        auto_end,
        reject_unauthorized,
        ca,
        socket.clone(),
        callback,
    );
    http_agent_track(agent, &request, name, queued);
    if !queued {
        if let Some(socket) = socket {
            net_socket_start_connect(&socket);
        }
    }
    request
}

pub fn http_agent_client_request(
    agent: &JsHttpAgent,
    host: &JsString,
    port: f64,
    path: &JsString,
    method: &JsString,
    timeout: f64,
    headers: &JsArray<JsString>,
    auto_end: bool,
) -> JsHttpClientRequest {
    http_agent_client_request_impl(
        agent,
        host,
        port,
        path,
        method,
        timeout,
        headers,
        auto_end,
        false,
        true,
        &empty_string(),
        None,
    )
}

pub fn http_agent_client_request_callback(
    agent: &JsHttpAgent,
    host: &JsString,
    port: f64,
    path: &JsString,
    method: &JsString,
    timeout: f64,
    headers: &JsArray<JsString>,
    auto_end: bool,
    callback: Rc<dyn Fn(JsHttpRequest)>,
    trace: NetTrace,
) -> JsHttpClientRequest {
    http_agent_client_request_impl(
        agent,
        host,
        port,
        path,
        method,
        timeout,
        headers,
        auto_end,
        false,
        true,
        &empty_string(),
        Some((callback, trace)),
    )
}

fn http_agent_client_done(agent: &JsHttpAgent, request: &JsHttpClientRequest) {
    let socket = agent.with_mut(|agent| {
        let name = agent
            .entries
            .iter()
            .find(|entry| entry.request.ptr_eq(request))
            .map(|entry| entry.name.clone());
        agent.entries.retain(|entry| !entry.request.ptr_eq(request));
        let Some(name) = name else {
            return None;
        };
        if agent.destroyed {
            return None;
        }
        let active = agent
            .entries
            .iter()
            .filter(|entry| !entry.queued && entry.name.as_ref() == name.as_ref())
            .count() as f64;
        if active >= agent.max_sockets || agent.max_sockets.is_nan() {
            return None;
        }
        for entry in &mut agent.entries {
            if entry.queued && entry.name.as_ref() == name.as_ref() {
                entry.queued = false;
                return entry.request.with(|request| request.socket.clone());
            }
        }
        None
    });
    if let Some(socket) = socket {
        net_socket_start_connect(&socket);
    }
}

pub fn http_agent_destroy(agent: &JsHttpAgent) {
    let requests = agent.with_mut(|agent| {
        agent.destroyed = true;
        agent.entries.iter().map(|entry| entry.request.clone()).collect::<Vec<_>>()
    });
    for request in requests {
        request.with_mut(|request| {
            request.agent = None;
        });
        http_client_destroy(&request);
    }
    agent.with_mut(|agent| agent.entries.clear());
}
