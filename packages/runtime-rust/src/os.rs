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
