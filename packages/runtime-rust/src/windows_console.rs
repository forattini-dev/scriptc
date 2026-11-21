//! Safe native replacement for the narrow `bun:ffi` console-mode contract.

#[cfg(windows)]
pub fn win_console_open() -> bool {
    winapi_util::console::mode(std::io::stdin()).is_ok()
}

#[cfg(not(windows))]
pub fn win_console_open() -> bool {
    false
}

#[cfg(windows)]
pub fn win_console_get_mode(open: bool, output: &crate::JsBytes<u32>) -> f64 {
    if !open {
        return 0.0;
    }
    match winapi_util::console::mode(std::io::stdin()) {
        Ok(mode) => {
            crate::bytes_set(output, 0.0, f64::from(mode));
            1.0
        }
        Err(_) => 0.0,
    }
}

#[cfg(not(windows))]
pub fn win_console_get_mode(_open: bool, _output: &crate::JsBytes<u32>) -> f64 {
    0.0
}

#[cfg(windows)]
pub fn win_console_set_mode(open: bool, mode: f64) -> f64 {
    if !open || !mode.is_finite() {
        return 0.0;
    }
    match winapi_util::console::set_mode(std::io::stdin(), mode as u32) {
        Ok(()) => 1.0,
        Err(_) => 0.0,
    }
}

#[cfg(not(windows))]
pub fn win_console_set_mode(_open: bool, _mode: f64) -> f64 {
    0.0
}

pub fn win_console_close(_open: bool) {}
