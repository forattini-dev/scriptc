// Node 24.15.0 / libuv's required_vars for Windows child processes:
// https://github.com/nodejs/node/blob/848430679556aed0bd073f2bc263331ad84fa119/deps/uv/src/win/process.c
#[cfg(windows)]
const CHILD_REQUIRED_WINDOWS_ENV: &[&str] = &[
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
];

fn child_configure_environment(
    command: &mut std::process::Command,
    explicit: Option<&JsArray<JsString>>,
) {
    let Some(pairs) = explicit else {
        process_env_apply(command);
        return;
    };
    command.env_clear();
    #[cfg(windows)]
    for name in CHILD_REQUIRED_WINDOWS_ENV {
        let supplied = pairs.with(|pairs| {
            pairs
                .elements()
                .as_chunks::<2>()
                .0
                .iter()
                .any(|pair| pair[0].to_utf8_lossy().eq_ignore_ascii_case(name))
        });
        if !supplied && let Some(value) = process_env_get(&string(name)) {
            command.env(name, value.to_utf8_lossy());
        }
    }
    pairs.with(|pairs| {
        for pair in pairs.elements().as_chunks::<2>().0 {
            command.env(pair[0].to_utf8_lossy(), pair[1].to_utf8_lossy());
        }
    });
}
