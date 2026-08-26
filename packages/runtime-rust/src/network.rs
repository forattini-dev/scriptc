thread_local! {
    static NET_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT: Cell<f64> = const { Cell::new(250.0) };
}

pub fn net_get_auto_select_family_attempt_timeout() -> f64 {
    NET_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT.with(Cell::get)
}

pub fn net_set_auto_select_family_attempt_timeout(value: f64) {
    if !value.is_finite() || value.trunc() != value {
        throw_range_error_code(
            format!(
                "The value of \"value\" is out of range. It must be an integer. Received {}",
                display_number(value)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    if !(1.0..=2_147_483_647.0).contains(&value) {
        throw_range_error_code(
            format!(
                "The value of \"value\" is out of range. It must be >= 1 && <= 2147483647. Received {}",
                display_number(value)
            ),
            "ERR_OUT_OF_RANGE",
        );
    }
    NET_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT.with(|timeout| timeout.set(value.max(10.0)));
}
