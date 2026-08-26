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
        let uid = process_getuid() as u64;
        if let Some(home) = std::fs::read_to_string("/etc/passwd")
            .ok()
            .and_then(|passwd| {
                passwd.lines().find_map(|line| {
                    let mut fields = line.split(':');
                    let _name = fields.next()?;
                    let _password = fields.next()?;
                    let stored_uid = fields.next()?.parse::<u64>().ok()?;
                    let _gid = fields.next()?;
                    let _description = fields.next()?;
                    let home = fields.next()?;
                    (stored_uid == uid && !home.is_empty()).then(|| home.to_owned())
                })
            })
        {
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
