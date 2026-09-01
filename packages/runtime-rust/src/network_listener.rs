#[cfg(target_os = "linux")]
fn net_configured_listener(
    host: &str,
    port: u16,
    ipv6_only: bool,
    reuse_port: bool,
) -> std::io::Result<std::net::TcpListener> {
    use rustix::net::{
        bind, ipproto, listen, socket, sockopt, AddressFamily, SocketAddrAny, SocketAddrV4,
        SocketAddrV6, SocketType,
    };

    let ip = host
        .parse::<std::net::IpAddr>()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let (family, address): (AddressFamily, SocketAddrAny) = match ip {
        std::net::IpAddr::V4(ip) => (AddressFamily::INET, SocketAddrV4::new(ip, port).into()),
        std::net::IpAddr::V6(ip) => (AddressFamily::INET6, SocketAddrV6::new(ip, port, 0, 0).into()),
    };
    let socket = socket(family, SocketType::STREAM, Some(ipproto::TCP)).map_err(std::io::Error::from)?;
    sockopt::set_socket_reuseaddr(&socket, true).map_err(std::io::Error::from)?;
    if family == AddressFamily::INET6 {
        sockopt::set_ipv6_v6only(&socket, ipv6_only).map_err(std::io::Error::from)?;
    }
    if reuse_port {
        sockopt::set_socket_reuseport(&socket, true).map_err(std::io::Error::from)?;
    }
    bind(&socket, &address).map_err(std::io::Error::from)?;
    listen(&socket, 511).map_err(std::io::Error::from)?;
    Ok(std::net::TcpListener::from(socket))
}

fn net_listener(
    host: &str,
    port: u16,
    ipv6_only: bool,
    reuse_port: bool,
) -> std::io::Result<std::net::TcpListener> {
    if ipv6_only || reuse_port {
        #[cfg(target_os = "linux")]
        {
            return net_configured_listener(host, port, ipv6_only, reuse_port);
        }
        #[cfg(not(target_os = "linux"))]
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "configured TCP listeners are unsupported on this target",
            ));
        }
    }
    std::net::TcpListener::bind((host, port))
}
