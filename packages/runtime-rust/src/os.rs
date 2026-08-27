pub fn os_tmpdir() -> JsString {
    let value = std::env::var_os("TMPDIR")
        .or_else(|| std::env::var_os("TMP"))
        .or_else(|| std::env::var_os("TEMP"))
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "."
            } else {
                "/tmp"
            }
            .to_owned()
        });
    let trimmed = if value.len() > 1 {
        value.trim_end_matches(['/', '\\'])
    } else {
        value.as_str()
    };
    Rc::from(trimmed)
}

fn os_command_output(command: &str, arguments: &[&str]) -> Option<String> {
    let output = std::process::Command::new(command)
        .args(arguments)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn os_passwd_field(index: usize) -> Option<String> {
    if cfg!(target_os = "windows") {
        return None;
    }
    let uid = format_number(process_getuid());
    let record = os_command_output("getent", &["passwd", &uid])
        .or_else(|| os_command_output("id", &["-P", &uid]))
        .or_else(|| {
            std::fs::read_to_string("/etc/passwd")
                .ok()?
                .lines()
                .find(|line| line.split(':').nth(2) == Some(uid.as_str()))
                .map(str::to_owned)
        })?;
    record.split(':').nth(index).map(str::to_owned)
}

pub fn os_homedir() -> JsString {
    let variable = if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    };
    if let Some(home) = process_env_get(&string(variable)).filter(|value| !value.is_empty()) {
        return home;
    }
    if cfg!(target_os = "windows") {
        let drive = process_env_get(&string("HOMEDRIVE")).unwrap_or_else(empty_string);
        let path = process_env_get(&string("HOMEPATH")).unwrap_or_else(empty_string);
        if !drive.is_empty() || !path.is_empty() {
            return string(&format!("{drive}{path}"));
        }
    } else {
        if let Some(home) = os_passwd_field(5).filter(|home| !home.is_empty()) {
            return string(&home);
        }
    }
    Rc::from(
        std::env::current_dir()
            .expect("scriptc: os.homedir() failed")
            .to_string_lossy()
            .as_ref(),
    )
}

pub fn os_user_name() -> JsString {
    os_passwd_field(0)
        .or_else(|| {
            std::env::var_os(if cfg!(target_os = "windows") {
                "USERNAME"
            } else {
                "USER"
            })
            .map(|value| value.to_string_lossy().into_owned())
        })
        .map_or_else(empty_string, |value| string(&value))
}

pub fn os_user_shell() -> JsString {
    if cfg!(target_os = "windows") {
        empty_string()
    } else {
        os_passwd_field(6).map_or_else(empty_string, |value| string(&value))
    }
}

pub fn os_user_homedir() -> JsString {
    os_passwd_field(5)
        .filter(|home| !home.is_empty())
        .map_or_else(os_homedir, |value| string(&value))
}

pub fn os_type() -> JsString {
    string(if cfg!(target_os = "windows") {
        "Windows_NT"
    } else if cfg!(target_os = "macos") {
        "Darwin"
    } else if cfg!(target_os = "linux") || cfg!(target_os = "android") {
        "Linux"
    } else if cfg!(target_os = "wasi") {
        "WASI"
    } else {
        return os_command_output("uname", &["-s"]).map_or_else(empty_string, |value| string(&value));
    })
}

pub fn os_release() -> JsString {
    let value = if cfg!(target_os = "windows") {
        os_command_output(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[System.Environment]::OSVersion.Version.ToString()",
            ],
        )
    } else if cfg!(target_os = "wasi") {
        None
    } else {
        os_command_output("uname", &["-r"])
    };
    value.map_or_else(empty_string, |value| string(&value))
}

pub fn os_totalmem() -> f64 {
    if cfg!(target_os = "linux") || cfg!(target_os = "android") {
        return std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|info| {
                info.lines().find_map(|line| {
                    line.strip_prefix("MemTotal:")?
                        .split_whitespace()
                        .next()?
                        .parse::<f64>()
                        .ok()
                })
            })
            .map_or(0.0, |kibibytes| kibibytes * 1024.0);
    }
    let output = if cfg!(target_os = "windows") {
        os_command_output(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ],
        )
    } else if cfg!(target_os = "wasi") {
        None
    } else {
        os_command_output("sysctl", &["-n", "hw.memsize"])
    };
    output.and_then(|value| value.parse().ok()).unwrap_or(0.0)
}

#[derive(Clone)]
pub struct OsNetworkInterfaceRow {
    pub name: JsString,
    pub address: JsString,
    pub netmask: JsString,
    pub family: JsString,
    pub mac: JsString,
    pub internal: bool,
    pub cidr: Option<JsString>,
    pub ipv6: bool,
    pub scopeid: f64,
}

fn os_netmask_prefix(bytes: &[u8]) -> Option<usize> {
    let mut ones = 0;
    let mut zero_seen = false;
    for byte in bytes {
        for bit in (0..8).rev() {
            if byte & (1 << bit) != 0 {
                if zero_seen {
                    return None;
                }
                ones += 1;
            } else {
                zero_seen = true;
            }
        }
    }
    Some(ones)
}

#[cfg(windows)]
fn os_interface_name(interface: &getifaddrs::Interface) -> &str {
    &interface.description
}

#[cfg(all(
    not(windows),
    any(
        target_os = "linux",
        target_os = "android",
        target_vendor = "apple",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    )
))]
fn os_interface_name(interface: &getifaddrs::Interface) -> &str {
    &interface.name
}

#[cfg(any(
    windows,
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
))]
pub fn os_network_interfaces() -> Vec<OsNetworkInterfaceRow> {
    use getifaddrs::{Address, InterfaceFlags};

    let interfaces: Vec<_> = match getifaddrs::getifaddrs() {
        Ok(interfaces) => interfaces.collect(),
        Err(_) => return Vec::new(),
    };
    let active = |flags: InterfaceFlags| {
        flags.contains(InterfaceFlags::UP) && flags.contains(InterfaceFlags::RUNNING)
    };
    let mut macs = HashMap::<String, [u8; 6]>::new();
    for interface in &interfaces {
        if active(interface.flags) {
            if let Address::Mac(mac) = &interface.address {
                macs.insert(os_interface_name(interface).to_owned(), *mac);
            }
        }
    }
    let zero_mac = [0_u8; 6];
    interfaces
        .into_iter()
        .filter_map(|interface| {
            if !active(interface.flags) {
                return None;
            }
            let name = os_interface_name(&interface).to_owned();
            let internal = interface.flags.contains(InterfaceFlags::LOOPBACK);
            let mac = macs.get(&name).unwrap_or(&zero_mac);
            let mac = string(&format!(
                "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
                mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
            ));
            let (address, netmask, ipv6, scopeid, prefix) = match interface.address {
                Address::V4(value) => {
                    let netmask = value.netmask.unwrap_or(std::net::Ipv4Addr::UNSPECIFIED);
                    let prefix = os_netmask_prefix(&netmask.octets());
                    (value.address.to_string(), netmask.to_string(), false, 0.0, prefix)
                }
                Address::V6(value) => {
                    let netmask = value.netmask.unwrap_or(std::net::Ipv6Addr::UNSPECIFIED);
                    let prefix = os_netmask_prefix(&netmask.octets());
                    let scoped = value.address.is_unicast_link_local() || value.address.is_multicast();
                    let scopeid = if scoped { interface.index.unwrap_or(0) as f64 } else { 0.0 };
                    (value.address.to_string(), netmask.to_string(), true, scopeid, prefix)
                }
                Address::Mac(_) => return None,
            };
            let cidr = prefix.map(|prefix| string(&format!("{address}/{prefix}")));
            Some(OsNetworkInterfaceRow {
                name: string(&name),
                address: string(&address),
                netmask: string(&netmask),
                family: string(if ipv6 { "IPv6" } else { "IPv4" }),
                mac,
                internal,
                cidr,
                ipv6,
                scopeid,
            })
        })
        .collect()
}

#[cfg(not(any(
    windows,
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
)))]
pub fn os_network_interfaces() -> Vec<OsNetworkInterfaceRow> {
    Vec::new()
}
