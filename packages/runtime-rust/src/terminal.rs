#[cfg(not(any(windows, target_os = "wasi")))]
thread_local! {
    static STDIN_COOKED: RefCell<Option<rustix::termios::Termios>> = const { RefCell::new(None) };
}

pub fn process_stdin_set_raw_mode(raw: bool) {
    if !process_is_tty(0.0) {
        throw_type_error("process.stdin.setRawMode is not a function".to_owned());
    }
    #[cfg(not(any(windows, target_os = "wasi")))]
    set_stdin_raw_mode(raw);
    #[cfg(any(windows, target_os = "wasi"))]
    let _ = raw;
}

#[cfg(not(any(windows, target_os = "wasi")))]
fn set_stdin_raw_mode(raw: bool) {
    use rustix::termios::{
        tcgetattr, tcsetattr, ControlModes, InputModes, LocalModes, OptionalActions,
        OutputModes, SpecialCodeIndex,
    };

    let stdin = std::io::stdin();
    if raw {
        let Ok(mut mode) = tcgetattr(&stdin) else { return };
        STDIN_COOKED.with(|saved| {
            if saved.borrow().is_none() {
                *saved.borrow_mut() = Some(mode.clone());
            }
        });
        mode.input_modes.remove(
            InputModes::BRKINT | InputModes::ICRNL | InputModes::INPCK |
                InputModes::ISTRIP | InputModes::IXON,
        );
        mode.output_modes.insert(OutputModes::ONLCR);
        mode.control_modes.insert(ControlModes::CS8);
        mode.local_modes.remove(
            LocalModes::ECHO | LocalModes::ICANON | LocalModes::IEXTEN | LocalModes::ISIG,
        );
        mode.special_codes[SpecialCodeIndex::VMIN] = 1;
        mode.special_codes[SpecialCodeIndex::VTIME] = 0;
        let _ = tcsetattr(&stdin, OptionalActions::Drain, &mode);
    } else {
        STDIN_COOKED.with(|saved| {
            if let Some(mode) = saved.borrow().as_ref() {
                let _ = tcsetattr(&stdin, OptionalActions::Drain, mode);
            }
        });
    }
}

fn terminal_finish() {
    #[cfg(not(any(windows, target_os = "wasi")))]
    STDIN_COOKED.with(|saved| {
        if let Some(mode) = saved.borrow_mut().take() {
            let _ = rustix::termios::tcsetattr(
                std::io::stdin(),
                rustix::termios::OptionalActions::Drain,
                &mode,
            );
        }
    });
}
